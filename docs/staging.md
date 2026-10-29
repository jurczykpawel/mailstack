# Staging Mailstacka

## SES i SNS (ST2)

Region: `eu-west-1`, konto `207570392857`. Nadawca:
`Mailstack staging <no-reply@mailstack-test.techskills.academy>`.
Osobna tożsamość domenowa Easy DKIM: `mailstack-test.techskills.academy`.
Configuration set: `mailstack-staging`; temat SNS:
`arn:aws:sns:eu-west-1:207570392857:mailstack-staging-events`.

**Stan zmierzony 29.10.2026:** konto ma `ProductionAccessEnabled: true`.
Sandbox SES dotyczy konta w regionie, a nie tożsamości ani configuration set.
ST2 nie zmienia tego ustawienia. Ograniczenie stagingu zapewnia dedykowany
użytkownik IAM z polityką `scripts/staging/ses-policy.json`, dopuszczającą tylko
cztery dokładne adresy symulatora. Bez tej polityki i dedykowanego klucza
wysyłka Workera ma pozostać wyłączona. Nie używaj kluczy produkcji ani `default`
do wysyłania z aplikacji.

### Zarządzanie zasobami

Wymagane: Bash, Python 3, AWS CLI, odblokowane konto agenta Vaultwarden.
Cloudflare token jest pobierany w pamięci z `CF Deploy - General API token`.
Nie przekazuj sekretów jako argumentów CLI ani nie włączaj śledzenia powłoki.

```bash
source ~/.zshenv
scripts/staging/ses.sh status
scripts/staging/ses.sh create
# Usuwa tylko staging SES/SNS oraz jego dokładne CNAME DKIM:
scripts/staging/ses.sh destroy
```

Skrypt używa wyłącznie profilu AWS `default`, sprawdza ARN użytkownika `pavvel-cli`
i stałe konto/region/nazwy zasobów. Nie zarządza IAM ani kluczami.
`create` można powtarzać; oczekuje maksymalnie około dwóch minut na Easy DKIM.
Dowody i pełne listy DNS przed/po zapisuje poza repo w
`~/.local/state/mailstack-staging-ses/<UTC>/` (katalog 0700, pliki 0600).
`MAILSTACK_SES_STATE` pozwala wskazać inny katalog poza repo.
Różnica DNS może obejmować wyłącznie oczekiwane rekordy DKIM; wszystkie inne
rekordy oraz listy produkcyjnych SES/SNS i wdrożenia Workera `mailstack`
muszą być identyczne. Niedostępna lista IAM jest oznaczana `UNAVAILABLE`.
`destroy` nie usuwa użytkownika IAM ani wpisu Vaultwarden; owner powinien osobno
wycofać klucz i usunąć dedykowanego użytkownika po zakończeniu stagingu.

### IAM: czynność ownera

`pavvel-cli` otrzymał AccessDenied dla `iam:CreateUser` i `iam:ListUsers`.
Nie rozszerzaj jego uprawnień. Osoba z istniejącymi uprawnieniami administracji
IAM powinna:

1. Sprawdzić, czy `mailstack-staging-ses` już istnieje; jeśli tak, sprawdzić jego
   polityki, grupy i klucze zamiast tworzyć następny klucz.
2. Utworzyć użytkownika bez dostępu do konsoli, bez grup i bez innych polityk.
3. Dodać inline policy `mailstack-staging-send` z pliku
   `scripts/staging/ses-policy.json`:

   ```bash
   aws iam create-user --user-name mailstack-staging-ses
   aws iam put-user-policy --user-name mailstack-staging-ses \
     --policy-name mailstack-staging-send \
     --policy-document file://scripts/staging/ses-policy.json
   ```

4. Utworzyć **jeden** klucz w konsoli IAM i zapisać bezpośrednio w Vaultwarden,
   organizacja TechSkillsAcademy, kolekcja Infra, wpis `Mailstack staging SES`:
   username = Access Key ID, password = Secret Access Key; region i ARN w notatce.
   Nie używać polecenia `create-access-key` wypisującego sekret do terminala.
   Nie zapisywać klucza w plikach, repo, logach ani raportach.
5. Zweryfikować zakres polityki i brak innych uprawnień; przekazać ST1 możliwość
   zasilenia wyłącznie sekretów stagingu. Uzupełnić porównanie użytkowników IAM
   wykonane przez uprawnioną osobę.

Polityka dopuszcza tylko stagingowe ARN-y tożsamości i configuration set.
Wywołanie aplikacji musi podawać `SES_CONFIGURATION_SET=mailstack-staging`;
lista ARN-ów sama nie wymusza obecności opcjonalnego parametru configuration set.
Skrypt nie zmienia kontowego sandboxa ani planu cenowego SES.

### Po wdrożeniu ST1: podłączenie zdarzeń

Worker: `https://mailstack-test.techskills.academy`. Endpoint odczytany z
`src/index.ts` i README: `/v1/events/ses`. Konfiguracja Workera musi zawierać:

```json
{"events":{"ses":{
  "topicArns":["arn:aws:sns:eu-west-1:207570392857:mailstack-staging-events"],
  "accountIds":["207570392857"]
}}}
```

Ustaw `SES_REGION=eu-west-1`, `SES_CONFIGURATION_SET=mailstack-staging`,
dedykowane `SES_ACCESS_KEY_ID`/`SES_SECRET_ACCESS_KEY` oraz stagingowe
`CONTENT_PUBLIC_KEYS` i `INDEX_KEYS`. Włącz zapis wiadomości: poziom `masked`
i `requireLog: true`. Dla `none` aplikacja nie dodaje tagów korelacyjnych ani
configuration set. Ustaw brand.to na adres symulatora i wyłącz auto-reply.

Po skonfigurowaniu i wdrożeniu Workera uruchom ponownie `create`, albo wykonaj:

```bash
aws --profile default --region eu-west-1 sns subscribe \
  --topic-arn arn:aws:sns:eu-west-1:207570392857:mailstack-staging-events \
  --protocol https \
  --notification-endpoint https://mailstack-test.techskills.academy/v1/events/ses \
  --attributes '{"RawMessageDelivery":"false"}'
```

Worker potwierdza subskrypcję po walidacji podpisu SNS v2. `status` zapisuje
listę subskrypcji: wymagany rzeczywisty ARN zamiast `PendingConfirmation`.
Jeśli potwierdzenie nie doszło, po naprawie konfiguracji ponów `sns subscribe`
z tymi samymi parametrami; skrypt nie powiela istniejącej subskrypcji.

### Symulator i odczyt wyników

| Odbiorca | Oczekiwane zdarzenie |
| --- | --- |
| `success@simulator.amazonses.com` | Delivery |
| `bounce@simulator.amazonses.com` | Bounce |
| `complaint@simulator.amazonses.com` | Complaint |
| `suppressionlist@simulator.amazonses.com` | Bounce (symulacja suppression list) |

Wysyłaj pojedyncze syntetyczne wiadomości przez `/v1/send` z dedykowanym
klientem stagingu. Zachowaj zwrócone `id`; w panelu/oś czasu i API logów
sprawdź tę samą wiadomość oraz jej zdarzenia. `Send` oznacza przyjęcie przez SES,
`Delivery` doręczenie symulatorowi, `Bounce` odrzucenie, a `Complaint` ustawia
flagę reklamacji. Temat emituje SEND, DELIVERY, BOUNCE, COMPLAINT i REJECT;
nie włączono płatnych dodatków ani śledzenia open/click.
Żądanie wysłane bez logu nie da pełnego testu korelacji. Potwierdzenie subskrypcji
nie jest dowodem poprawnej obsługi Delivery/Bounce/Complaint: te trzy zdarzenia
trzeba sprawdzić po ST1 i IAM. ST2 nie wysyłał wiadomości.

Nie zweryfikowano Mailpita jako odbiorcy poczty tej domeny; nie jest odbiorcą SES.
Nie kieruj żadnych prób na skrzynki ludzi.

### Koszty

Tożsamość, Easy DKIM, configuration set, standardowy temat i DNS nie mają opłaty
stałej. Symulator SES jest **płatny jak zwykła wysyłka**; sandbox nie zwalnia z opłat.
Dla planu à la carte stawka wynosi 0,10 USD/1000 wiadomości plus dane. Cztery małe
wiadomości to około 0,0004 USD plus dane i SNS. Nie uruchamiaj testów obciążeniowych.
SNS ma darmowe limity konta; ich dostępności dla stagingu nie potwierdzono.
Nie aktywuj SES Pro, VDM, dedicated IP ani innych dodatków.

Odczyt `budgets describe-budgets` zwrócił exit 0, ale pusty wynik (również po
`--no-paginate`); nie potwierdzono istniejącego budżetu. Propozycja dla ownera:
sprawdzić AWS Budgets i dodać powiadomienie kosztowe dla SES/SNS, np. 1 USD/mies.,
bez automatycznych płatnych akcji. ST2 nie tworzy budżetu ani alarmu CloudWatch.

Źródła: [sandbox per region](https://docs.aws.amazon.com/ses/latest/dg/regions.html),
[symulator i rozliczanie](https://docs.aws.amazon.com/ses/latest/dg/send-an-email-from-console.html),
[cennik SES](https://aws.amazon.com/ses/pricing/),
[cennik SNS](https://aws.amazon.com/sns/pricing/).
