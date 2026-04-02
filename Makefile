DOMAIN ?= mcp.example.com

.PHONY: deploy restart stop logs ps health token nginx-setup ssl

# Mettre à jour et relancer le container
deploy:
	git pull
	docker compose up -d --build

# Redémarrer le container sans rebuild
restart:
	docker compose restart mcp-postgresdb

# Arrêter le container
stop:
	docker compose down

# Suivre les logs en temps réel
logs:
	docker compose logs -f

# État du container
ps:
	docker compose ps

# Vérifier que le serveur répond
health:
	curl -s http://localhost:3000/health

# Générer un nouveau Bearer token
token:
	@openssl rand -hex 32

# Installer la config nginx (DOMAIN=votre-domaine.com make nginx-setup)
nginx-setup:
	cp .docker/nginx.conf /etc/nginx/sites-available/mcp-postgresdb
	sed -i 's/mcp.example.com/$(DOMAIN)/g' /etc/nginx/sites-available/mcp-postgresdb
	ln -sf /etc/nginx/sites-available/mcp-postgresdb /etc/nginx/sites-enabled/mcp-postgresdb
	nginx -t && systemctl reload nginx

# Obtenir un certificat SSL via Certbot — à lancer AVANT nginx-setup (DOMAIN=votre-domaine.com make ssl)
ssl:
	certbot certonly --nginx -d $(DOMAIN)
