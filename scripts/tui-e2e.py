"""Loads the TUI entry in an isolated OpenCode (temp XDG dirs and HOME, private server)
inside a pseudo-terminal, then drives the command palette. Run after `pnpm run build`:
python3 scripts/tui-e2e.py"""
import datetime, fcntl, json, os, pty, re, select, shutil, struct, sys, tempfile, termios, time
repo=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
root=tempfile.mkdtemp(prefix="advisor-tui-")
d={k:os.path.join(root,k) for k in ["config","data","state","cache","work","home"]}
for v in d.values(): os.makedirs(v)
os.makedirs(d["config"]+"/opencode")
pd=d["config"]+"/opencode/plugins/model-advisor"
os.makedirs(pd)
for n in ["index.js","tui.tsx","package.json"]: shutil.copy(repo+"/"+n,pd+"/"+n)
for n in ["dist","tui","node_modules"]: os.symlink(repo+"/"+n,pd+"/"+n)
open(root+"/model-advisor.jsonc","w").write('{"mode":"shadow"}\n')
env=dict(os.environ,HOME=d["home"],XDG_CONFIG_HOME=d["config"],XDG_DATA_HOME=d["data"],XDG_STATE_HOME=d["state"],XDG_CACHE_HOME=d["cache"],OPENCODE_MODEL_ADVISOR_CONFIG=root+"/model-advisor.jsonc",OPENCODE_MODEL_ADVISOR_DECISIONS=root+"/decisions.jsonl",TERM="xterm-256color",COLUMNS="140",LINES="40")
pid,fd=pty.fork()
if pid==0:
    os.chdir(d["work"]); os.execvpe("opencode",["opencode","--standalone"],env)
fcntl.ioctl(fd,termios.TIOCSWINSZ,struct.pack("HHHH",40,140,0,0))
buf=b""
def pump(sec):
    global buf
    end=time.time()+sec
    while time.time()<end:
        r,_,_=select.select([fd],[],[],0.2)
        if r:
            try: buf+=os.read(fd,65536)
            except OSError: return
open(root+"/decisions.jsonl","w").write(json.dumps({"v":1,"kind":"decision","t":datetime.datetime.now(datetime.timezone.utc).isoformat(),"id":"d1","session":"s1","agent":"builder","mode":"shadow","model":"claude-opus-5-5","would":"claude-sonnet-5-5","tier":"sonnet","source":"rule","rule":"read-only","reason":"rule read-only"})+"\n"+json.dumps({"v":1,"kind":"alert","t":"2999-01-01T00:00:00Z","alert":"second-failure","agent":"builder","task":"7"})+"\n")
pump(10)
os.write(fd,b"\x10")  # ctrl+p palette
pump(2)
os.write(fd,b"advisor")
pump(3)
def screen():
    return re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]",b" ",buf).decode("utf8","ignore")
os.write(fd,b"\x15: decisions"); pump(1)
os.write(fd,b"\r"); pump(2)
print("decisions dialog:", "builder  opus → sonnet" in screen(), "Would change the model" in screen(), "read-only" in screen())
os.write(fd,b"\x1b"); pump(1)
os.write(fd,b"\x10"); pump(1)
os.write(fd,b"advisor: mode"); pump(1)
os.write(fd,b"\r"); pump(2)
print("confirm dialog:", "Switch to enforce?" in screen())
os.write(fd,b"\r"); pump(2)
print("config after:", open(root+"/model-advisor.jsonc").read().strip())
open(root+"/decisions.jsonl","a").write(json.dumps({"v":1,"kind":"alert","t":"2999-01-01T00:00:01Z","alert":"judge-failed","agent":"builder","detail":"timeout"})+"\n")
pump(5)
print("toast:", "Judge failing" in screen())
os.write(fd,b"\x10"); pump(1)
os.write(fd,b"Model router: check"); pump(1)
os.write(fd,b"\r"); pump(2)
check_prompt="or a task id" in screen()
print("check prompt:", check_prompt)
os.write(fd,b"[[route: task=1 risk=high files=12]]"); pump(1)
os.write(fd,b"\r"); pump(3)
check_result="nothing dispatched" in screen() and "connectors: not configured" in screen()
print("check result:", check_result)
os.write(fd,b"\x1b"); pump(1)
os.write(fd,b"\x10"); pump(1)
os.write(fd,b"Model router: settings"); pump(1)
os.write(fd,b"\r"); pump(2)
settings_dialog="risk x difficulty matrix" in screen()
print("settings dialog:", settings_dialog)
os.write(fd,b"\x1b"); pump(1)
txt=re.sub(rb"\x1b\[[0-9;?]*[A-Za-z]",b" ",buf).decode("utf8","ignore")
print("bytes",len(buf))
for m in ["advisor: mode","advisor: pin","advisor: decisions","error","Error","failed"]:
    print(m, txt.count(m))
os.write(fd,b"\x03\x03"); pump(1)
try: os.kill(pid,9)
except: pass



ok = all(m in txt for m in ["advisor: mode", "advisor: pin", "advisor: decisions", "Model router: check", "Model router: settings", "Model router: calibration"]) and check_prompt and check_result and settings_dialog
shutil.rmtree(root, ignore_errors=True)
sys.exit(0 if ok else 1)
