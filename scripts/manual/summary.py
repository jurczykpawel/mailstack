import pathlib,sys,collections
root=pathlib.Path(sys.argv[1]); lines=['# Podsumowanie testów manualnych','','Liczby pochodzą wyłącznie z unikalnego rejestru FINDING. Brak raportu/stopki nie oznacza PASS.','','| Przebieg | Stan | BŁĄD B/P/D/K | UWAGA B/P/D/K | Raport |','|---|---|---|---|---|']
for id in ['REG-A','REG-B','EXP-1','RETEST','EXP-2','INTEGRATOR']:
    path=root/f'priv/reports/manual-{id}.md'; text=path.read_text() if path.exists() else ''
    counts={kind:collections.Counter() for kind in ['BŁĄD','UWAGA']}; seen=set()
    for line in text.splitlines():
        cells=[x.strip() for x in line.split('|')]
        if len(cells)>5 and cells[1]=='FINDING' and cells[2] not in seen and cells[3] in counts:
            seen.add(cells[2]); counts[cells[3]][cells[4]]+=1
    values=['/'.join(str(counts[k][w]) for w in ['blokujący','poważny','drobny','kosmetyczny']) for k in counts]
    status='UKOŃCZONO' if 'TASK-DONE '+id in text.splitlines() else 'NIE UKOŃCZONO'
    lines.append(f'| {id} | {status} | {values[0]} | {values[1]} | {path.relative_to(root)} |')
(root/'priv/reports/manual-summary.md').write_text('\n'.join(lines)+'\n')
