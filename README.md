# mcp-postgresdb-readonly

Serveur MCP pour accès PostgreSQL en lecture seule. Expose des outils d'exploration et de requêtage à tout client compatible MCP. Les opérations d'écriture sont bloquées au niveau applicatif, indépendamment des droits de l'utilisateur de la base de données.

Supporte jusqu'à trois environnements : **stg**, **tst**, **prod**. Chaque environnement est optionnel, seuls ceux avec un `HOST` configuré sont chargés.

## Outils

| Outil | Description |
|---|---|
| `query` | Exécute une requête SELECT (écritures rejetées) |
| `list-tables` | Liste les tables d'un schéma |
| `describe-table` | Affiche colonnes, types, nullabilité, valeurs par défaut |
| `list-schemas` | Liste tous les schémas définis par l'utilisateur |
| `list-environments` | Liste les environnements configurés (sans credentials) |

## Installation

```bash
npm install
npm run build
```

Copier `.env.dist` en `.env` et renseigner les credentials :

```bash
cp .env.dist .env
```

`.env` est git-ignoré et ne doit jamais être commité.

## Variables d'environnement

Chaque environnement utilise le préfixe `POSTGRES_{ENV}_` où `{ENV}` vaut `STG`, `TST` ou `PROD`.

| Variable | Obligatoire | Défaut | Description |
|---|---|---|---|
| `POSTGRES_{ENV}_HOST` | oui | - | Hostname. Son absence exclut l'environnement. |
| `POSTGRES_{ENV}_PORT` | non | `5432` | Port TCP |
| `POSTGRES_{ENV}_DATABASE` | oui | - | Nom de la base |
| `POSTGRES_{ENV}_USER` | oui | - | Utilisateur |
| `POSTGRES_{ENV}_PASSWORD` | oui | - | Mot de passe |
| `POSTGRES_{ENV}_SCHEMA` | non | `public` | Schéma par défaut |
| `POSTGRES_{ENV}_SSL` | non | `true` | Mettre à `false` pour désactiver SSL (local uniquement) |

### Exemple minimal

```bash
POSTGRES_PROD_HOST=my-cluster.rds.amazonaws.com
POSTGRES_PROD_DATABASE=mydb
POSTGRES_PROD_USER=reader
POSTGRES_PROD_PASSWORD=secret
```

## Intégration

Le serveur communique via **stdio** (standard MCP). La commande de démarrage est :

```bash
node /chemin/absolu/vers/mcp-postgresdb-readonly/dist/index.js
```

Le serveur lit les credentials depuis le fichier `.env` situé à la racine du projet. Aucun argument supplémentaire n'est nécessaire.

Exemple de configuration pour un client MCP :

```json
{
  "mcpServers": {
    "postgresdb-readonly": {
      "command": "node",
      "args": ["/chemin/absolu/vers/mcp-postgresdb-readonly/dist/index.js"]
    }
  }
}
```

## Protections

Trois mécanismes protègent la base contre les requêtes abusives (boucles IA, hallucinations) :

| Protection | Variable | Défaut | Description |
|---|---|---|---|
| Rate limiter | `RATE_LIMIT_PER_MINUTE` | `60` | Fenêtre glissante d'une minute. Au-delà, les requêtes sont rejetées avec une erreur. |
| Statement timeout | `QUERY_TIMEOUT_MS` | `30000` | Durée max d'exécution côté PostgreSQL (en ms). La requête est annulée automatiquement si le délai est dépassé. |
| Auto LIMIT | `MAX_ROWS` | `1000` | Si aucun `LIMIT` n'est présent dans la requête, un `LIMIT {MAX_ROWS}` est injecté automatiquement. |

Les valeurs sont configurables dans `.env`. Le log de démarrage affiche les paramètres actifs.

## Logs

Chaque requête est loggée sur `stderr` au format :

```
[HH:MM:SS] ENV  outil | clé=valeur | ...
```

Exemples :

```
[11:52:26] PROD  query         | duration=257ms | rows=3    | sql=SELECT id, mail FROM users.user LIMIT 3
[11:52:26] STG   list-tables   | schema=users   | duration=300ms | tables=94
[11:52:26] TST   describe-table| schema=users   | table=subscription | duration=247ms | columns=32
[11:52:26] PROD  query         | duration=12ms  | rows=1000 | limit=auto:1000 | sql=SELECT * FROM users.user
[11:52:26] STG   query         | status=BLOCKED (write) | sql=INSERT INTO ...
[11:52:26] PROD  query         | status=RATE LIMITED | limit=60/min
```

L'env est affiché en couleur si `stderr` est un TTY (`PROD` rouge, `STG` jaune, `TST` cyan).

## Sécurité

- Les mots-clés d'écriture (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `REPLACE`, `GRANT`, `REVOKE`, `MERGE`, `UPSERT`, `VACUUM`, `REINDEX`) sont rejetés avant que la requête n'atteigne la base.
- Utiliser de préférence un utilisateur base de données dédié en lecture seule. Ne jamais utiliser `owner` ou un superutilisateur.
- `.env` est dans `.gitignore`. Ne jamais commiter de credentials.
