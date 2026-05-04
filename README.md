# mcp-postgresdb-readonly

Serveur MCP pour accès PostgreSQL en **lecture seule**. Expose des outils d'exploration et de requêtage à tout client compatible MCP (Claude Code, Cursor, OpenCode, etc.).

Les opérations d'écriture sont bloquées au niveau applicatif, indépendamment des droits de l'utilisateur de la base de données.

Deux modes de fonctionnement :
- **stdio** : utilisé localement, l'agent IA lance le process directement.
- **HTTP** : hébergé sur un serveur, les agents s'y connectent via une URL.

Supporte jusqu'à trois environnements : **staging**, **test**, **prod**. Seuls ceux avec un `HOST` configuré sont chargés.

---

## Outils MCP

| Outil | Description |
|---|---|
| `query` | Exécute une requête SELECT (écritures rejetées) |
| `list-tables` | Liste les tables d'un schéma (ou de tous les schémas si aucun schéma par défaut n'est configuré) |
| `describe-table` | Affiche colonnes, types, nullabilité, valeurs par défaut (tous les schémas si aucun par défaut) |
| `list-schemas` | Liste tous les schémas définis par l'utilisateur |
| `list-environments` | Liste les environnements configurés (sans credentials) |

---

## Mode stdio (usage local)

Dans ce mode, chaque développeur installe le serveur sur sa propre machine. Le client IA (Claude Code, Cursor…) démarre automatiquement le serveur au moment où il en a besoin, et s'y connecte directement — pas de réseau, pas d'URL, pas de token.

Chaque développeur a ses propres credentials DB dans son `.env` local.

**Prérequis :** Node.js 18+ installé sur la machine.

### 1. Installer et builder

```bash
npm install
npm run build
```

### 2. Configurer

```bash
cp .env.dist .env
```

Renseigner dans `.env` au minimum un environnement :

```bash
POSTGRES_PROD_HOST=your-cluster.rds.amazonaws.com
POSTGRES_PROD_DATABASE=mydb
POSTGRES_PROD_USER=reader
POSTGRES_PROD_PASSWORD=secret
```

`.env` est git-ignoré et ne doit jamais être commité.

### 3. Déclarer le serveur dans le client IA

Le client IA a besoin du chemin absolu vers le fichier compilé. Récupérer ce chemin :

```bash
pwd
# exemple : /Users/alice/dev/mcp-postgresdb-readonly
# le fichier à déclarer : /Users/alice/dev/mcp-postgresdb-readonly/dist/index.js
```

**Claude Code** : `~/.claude/settings.json` :

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

**Cursor** : `.cursor/mcp.json` (projet) ou `~/.cursor/mcp.json` (global) :

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

Une fois configuré, redémarrer le client IA. Le serveur démarre automatiquement en arrière-plan à chaque session.

---

## Mode HTTP (serveur hébergé)

Le serveur tourne sur une machine distante et expose un endpoint HTTPS. Les agents locaux s'y connectent via URL + Bearer token. Personne n'a besoin d'installer Node ou les credentials DB en local.

### Architecture

```
Agents locaux (Claude, Cursor, OpenCode)
        │  HTTPS + Bearer token
        ▼
    nginx (SSL termination)
        │  HTTP loopback
        ▼
  Docker container  ←─── accès DB (prod/staging/test)
  (node dist/index.js, PORT=3000)
```

### 1. Prérequis serveur

- Un nom de domaine pointant vers le serveur (ex: `mcp.example.com`)
- Docker + Docker Compose
- Nginx
- Certbot (Let's Encrypt)
- `make` (optionnel, pour les commandes de gestion)

Installation sur Ubuntu/Debian :

```bash
# Docker
curl -fsSL https://get.docker.com | sh

# Nginx + Certbot
apt install -y nginx certbot python3-certbot-nginx make

# Démarrer et activer nginx
systemctl start nginx && systemctl enable nginx
```

### 2. Cloner le repo sur le serveur

```bash
git clone <repo-url> /opt/mcp-postgresdb-readonly
cd /opt/mcp-postgresdb-readonly
```

### 3. Configurer `.env`

```bash
cp .env.dist .env
```

Renseigner les credentials de base de données et **impérativement** générer un token d'auth :

```bash
# Générer un token sécurisé
openssl rand -hex 32
```

Exemple de `.env` :

```bash
# Token d'auth (obligatoire en mode HTTP)
MCP_AUTH_TOKEN=votre-token-généré-ici

# Connexion prod
POSTGRES_PROD_HOST=your-cluster.rds.amazonaws.com
POSTGRES_PROD_PORT=5432
POSTGRES_PROD_DATABASE=mydb
POSTGRES_PROD_USER=reader
POSTGRES_PROD_PASSWORD=secret
# POSTGRES_PROD_SCHEMA=myschema  # optional: restrict to a single schema; omit to access all schemas
POSTGRES_PROD_SSL=true

# Protections (optionnel, valeurs par défaut)
RATE_LIMIT_PER_MINUTE=60
QUERY_TIMEOUT_MS=30000
MAX_ROWS=1000
```

> `PORT` ne doit pas être dans `.env` pour le mode Docker, il est imposé à `3000` par `docker-compose.yml`.

### 4. Lancer le container

```bash
docker compose up -d --build
```

Vérifier que le container est en bonne santé :

```bash
docker compose ps
docker compose logs -f
curl http://localhost:3000/health
```

La réponse attendue :

```json
{"status":"ok","version":"2.0.0","environments":["prod"],"transport":"streamable-http"}
```

### 5. Obtenir un certificat SSL

La config nginx fournie référence les certificats Let's Encrypt. Il faut les obtenir **avant** d'activer cette config.

Laisser nginx tourner avec sa config par défaut (port 80), puis :

```bash
certbot certonly --nginx -d votre-domaine.com
```

`certonly` récupère uniquement le certificat sans modifier nginx.

### 6. Configurer nginx

Les certs existent maintenant, `nginx -t` passera :

```bash
DOMAIN=votre-domaine.com make nginx-setup
```

Ou manuellement :

```bash
cp .docker/nginx.conf /etc/nginx/sites-available/mcp-postgresdb
sed -i 's/mcp.example.com/votre-domaine.com/g' /etc/nginx/sites-available/mcp-postgresdb
ln -sf /etc/nginx/sites-available/mcp-postgresdb /etc/nginx/sites-enabled/mcp-postgresdb
nginx -t && systemctl reload nginx
```

### 7. Tester le endpoint

Vérifier que le token est bien exigé :

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST https://votre-domaine.com/mcp
# doit retourner 401
```

Lister les outils disponibles (valide le token + la connexion MCP) :

```bash
curl -s -X POST https://votre-domaine.com/mcp \
  -H "Authorization: Bearer votre-token-généré-ici" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1}'
```

### 8. Mettre à jour

```bash
make deploy
```

Ou manuellement :

```bash
git pull
docker compose up -d --build
```

---

## Configurer les agents en mode HTTP

Une fois le serveur en ligne, partager le token aux PMs et développeurs. Chacun ajoute la config suivante dans son agent.

### Claude Code

`~/.claude/settings.json` :

```json
{
  "mcpServers": {
    "postgresdb-readonly": {
      "type": "http",
      "url": "https://votre-domaine.com/mcp",
      "headers": {
        "Authorization": "Bearer votre-token"
      }
    }
  }
}
```

### Cursor

`.cursor/mcp.json` (projet) ou `~/.cursor/mcp.json` (global) :

```json
{
  "mcpServers": {
    "postgresdb-readonly": {
      "url": "https://votre-domaine.com/mcp",
      "headers": {
        "Authorization": "Bearer votre-token"
      }
    }
  }
}
```

### OpenCode

`~/.config/opencode/config.json` :

```json
{
  "mcp": {
    "postgresdb-readonly": {
      "type": "remote",
      "url": "https://votre-domaine.com/mcp",
      "headers": {
        "Authorization": "Bearer votre-token"
      }
    }
  }
}
```

---

## Makefile

Le `Makefile` regroupe les commandes courantes pour la gestion du serveur.

| Commande | Description |
|---|---|
| `make deploy` | `git pull` + rebuild + redémarrage du container |
| `make restart` | Redémarre le container sans rebuild |
| `make stop` | Arrête le container |
| `make logs` | Affiche les logs en temps réel |
| `make ps` | État du container |
| `make health` | Vérifie que le serveur répond sur `localhost:3000` |
| `make token` | Génère un nouveau Bearer token |
| `DOMAIN=... make nginx-setup` | Installe et active la config nginx |
| `DOMAIN=... make ssl` | Obtient un certificat SSL via Certbot |

---

## Troubleshooting

**Le container ne démarre pas**

```bash
make logs
# ou
docker compose logs
```

**Port 3000 déjà utilisé**

```bash
ss -tlnp | grep 3000
```

**La config nginx est invalide**

```bash
nginx -t
```

**Renouvellement SSL**

Certbot configure un timer systemd automatique. Pour forcer le renouvellement :

```bash
certbot renew --dry-run
```

**Vérifier que le container est en bonne santé**

```bash
make ps
make health
```

---

## Variables d'environnement

### Connexions base de données

Chaque environnement utilise le préfixe `POSTGRES_{ENV}_` où `{ENV}` vaut `STAGING`, `TEST` ou `PROD`.
Si `POSTGRES_{ENV}_HOST` est absent, l'environnement est ignoré.

| Variable | Obligatoire | Défaut | Description |
|---|---|---|---|
| `POSTGRES_{ENV}_HOST` | oui | - | Hostname PostgreSQL |
| `POSTGRES_{ENV}_PORT` | non | `5432` | Port TCP |
| `POSTGRES_{ENV}_DATABASE` | oui | - | Nom de la base |
| `POSTGRES_{ENV}_USER` | oui | - | Utilisateur |
| `POSTGRES_{ENV}_PASSWORD` | oui | - | Mot de passe |
| `POSTGRES_{ENV}_SCHEMA` | non | aucun (tous les schémas) | Restreint `list-tables` et `describe-table` à un schéma précis. Si absent, tous les schémas utilisateur sont accessibles. |
| `POSTGRES_{ENV}_SSL` | non | `true` | `false` pour désactiver SSL (local/dev uniquement) |

### Serveur HTTP

| Variable | Obligatoire | Défaut | Description |
|---|---|---|---|
| `PORT` | non | - | Si défini, démarre en mode HTTP sur ce port. Absent = mode stdio. |
| `MCP_AUTH_TOKEN` | recommandé | - | Bearer token requis dans l'en-tête `Authorization`. Absent = serveur non protégé. |

### Protections

| Variable | Défaut | Description |
|---|---|---|
| `RATE_LIMIT_PER_MINUTE` | `60` | Nombre max de requêtes par minute (fenêtre glissante globale) |
| `QUERY_TIMEOUT_MS` | `30000` | Timeout PostgreSQL côté serveur (ms). La requête est annulée si dépassé. |
| `MAX_ROWS` | `1000` | Si aucun `LIMIT` dans la requête, un `LIMIT {MAX_ROWS}` est injecté automatiquement. |

---

## Protections

Trois mécanismes protègent la base contre les requêtes abusives (boucles IA, hallucinations) :

- **Rate limiter** : fenêtre glissante d'une minute. Au-delà de `RATE_LIMIT_PER_MINUTE`, les requêtes sont rejetées.
- **Statement timeout** : durée max d'exécution côté PostgreSQL. La requête est annulée automatiquement si dépassée.
- **Auto LIMIT** : si aucun `LIMIT` n'est présent, `LIMIT {MAX_ROWS}` est injecté. Évite les scans complets accidentels.
- **Blocage écriture** : les mots-clés `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `REPLACE`, `GRANT`, `REVOKE`, `MERGE`, `UPSERT`, `VACUUM`, `REINDEX`, `COPY`, `DO`, `CALL` sont rejetés avant que la requête n'atteigne la base. Les commentaires SQL en tête de requête (`--`, `/* */`) sont strippés avant détection. `EXPLAIN ANALYZE <write>` est également bloqué (PostgreSQL exécute réellement la requête avec `ANALYZE`).

---

## Logs

Chaque requête est loggée sur `stderr` :

```
[HH:MM:SS] ENV  outil | clé=valeur | ...
```

Exemples :

```
[11:52:26] PROD  query          | duration=257ms | rows=3    | sql=SELECT id, mail FROM users.user LIMIT 3
[11:52:26] STAGING  list-tables    | schema=all     | duration=300ms | tables=212
[11:52:26] STAGING  list-tables    | schema=public  | duration=300ms | tables=94
[11:52:26] TEST     describe-table | schema=all     | table=orders   | duration=247ms | columns=32
[11:52:26] PROD     query          | duration=12ms  | rows=1000 | limit=auto:1000 | sql=SELECT * FROM public.orders
[11:52:26] STAGING  query          | status=BLOCKED (write) | sql=INSERT INTO ...
[11:52:26] PROD  query          | status=RATE LIMITED | limit=60/min
```

`PROD` s'affiche en rouge, `STAGING` en jaune, `TEST` en cyan (si `stderr` est un TTY).

---

## Sécurité

- Utiliser un utilisateur PostgreSQL dédié en lecture seule. Ne jamais utiliser `owner` ou un superutilisateur.
- En mode HTTP, toujours configurer `MCP_AUTH_TOKEN`. Générer un token par `openssl rand -hex 32`.
- `.env` est dans `.gitignore` et ne doit jamais être commité.
- En production, nginx est le seul point d'entrée public. Le container écoute uniquement sur `127.0.0.1:3000`.
