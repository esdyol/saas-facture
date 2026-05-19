# SaaS Factures IA

MVP full-stack inspire du rapport `rapport_saas_factures_ia.pdf`.

## Structure

- `backend/`: Django 5, modele multi-tenant, API JSON, admin, seed de demonstration
- `frontend/`: React + Vite, dashboard, upload simule, revue humaine, pricing

## Fonctionnalites deja posees

- organisations, utilisateurs, abonnements, factures, donnees extraites, taches de traitement
- auth JWT access/refresh, inscription d'organisation, session securisee
- upload via URL pre-signee S3/R2 si configure, sinon fallback local backend
- extraction PDF/image via `pypdf` puis `Tesseract` si necessaire, enrichissement heuristique et point d'entree Anthropic
- endpoints JSON pour dashboard, liste factures, detail, validation, stockage et plans
- seed de demonstration pour charger une organisation et plusieurs factures
- interface React exploitable sans bibliotheques UI externes

## Lancement backend

```bash
cd backend
python manage.py makemigrations
python manage.py migrate
python manage.py seed_demo
python manage.py runserver
```

Variables utiles:

- `backend/.env.example` montre les variables pour S3/R2 et Anthropic
- `TESSERACT_CMD` et `TESSERACT_LANG` pilotent l'OCR local
- `CELERY_BROKER_URL` et `CELERY_RESULT_BACKEND` activent le mode worker Redis/Celery
- sans configuration S3, le projet utilise automatiquement l'upload local backend
- sans `ANTHROPIC_API_KEY`, le projet utilise une extraction heuristique locale
- sans `CELERY_BROKER_URL`, le projet utilise un worker local par thread pour le developpement

## Passage a Celery + Redis

Lancer Redis:

```bash
cd backend
docker compose -f docker-compose.redis.yml up -d
```

Configurer ensuite:

```bash
CELERY_BROKER_URL=redis://127.0.0.1:6379/0
CELERY_RESULT_BACKEND=redis://127.0.0.1:6379/0
```

Lancer le worker:

```bash
cd backend
celery -A config worker --pool=solo --loglevel=info
```

## Lancement frontend

```bash
cd frontend
npm install
npm run dev
```

## Compte de demonstration

- `username`: `owner`
- `password`: `demo12345`

## Endpoints principaux

- `GET /api/health/`
- `POST /api/auth/register/`
- `POST /api/auth/login/`
- `POST /api/auth/refresh/`
- `GET /api/session/`
- `GET /api/dashboard/`
- `GET /api/invoices/`
- `POST /api/invoices/`
- `POST /api/invoices/local-upload/`
- `GET /api/invoices/<id>/`
- `POST /api/invoices/<id>/process/`
- `PATCH /api/invoices/<id>/validate/`
- `POST /api/storage/presign/`
- `GET /api/plans/`
- `GET /api/roadmap/`

## Prochaines integrations

- permissions fines par role
- upload direct S3/R2 en production avec bucket configure
- OCR image/Tesseract et traitement asynchrone Celery
- worker Celery + Redis reel en production
- Stripe Checkout, Portal et webhooks
- exports CSV/PDF, recherche full-text, tests et CI/CD
