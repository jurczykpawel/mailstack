import os, signal, subprocess, sys, time, shutil
profile = sys.argv[1]
if not profile.startswith('/private/tmp/mailstack-') or not profile.endswith('-chrome-profile'):
    raise SystemExit('Invalid test profile')
for line in subprocess.check_output(['ps','-axo','pid=,command='], text=True).splitlines():
    pid, _, command = line.strip().partition(' ')
    if ('Google Chrome' in command or 'chrome_crashpad_handler' in command) and '--user-data-dir='+profile in command:
        os.kill(int(pid), signal.SIGTERM)
        for _ in range(50):
            try: os.kill(int(pid), 0)
            except ProcessLookupError: break
            time.sleep(.1)
        else: raise SystemExit('Chrome did not close; profile retained')
shutil.rmtree(profile, ignore_errors=True)
