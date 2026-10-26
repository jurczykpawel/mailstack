import hashlib, pathlib, subprocess, sys
root=pathlib.Path(sys.argv[1]); digest=hashlib.sha256()
for repo in [root,root.parent/'mailstack-pro']:
    for args in [['rev-parse','HEAD'],['diff','HEAD','--','.']]:
        digest.update(subprocess.check_output(['git','-C',str(repo),*args]))
for path in sorted((root/'priv/briefs/manual').glob('*.md'))+sorted((root/'priv/plans').glob('*.md')):
    digest.update(path.name.encode()); digest.update(path.read_bytes())
print(digest.hexdigest())
