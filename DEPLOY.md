# Автодеплой на сервер

При каждом пуше в `main` GitHub Actions заходит на сервер по SSH, подтягивает свежий код и пересобирает контейнер.

## Шаг 1. Подготовка сервера (один раз)

На сервере должны быть установлены `git`, `docker` и `docker compose`.

Чтобы сервер мог клонировать приватный репозиторий, добавь **deploy key**:

```bash
# на сервере
ssh-keygen -t ed25519 -f ~/.ssh/dashboard_deploy -N ""
cat ~/.ssh/dashboard_deploy.pub
```

Публичный ключ добавь в GitHub: **репозиторий → Settings → Deploy keys → Add deploy key** (read-only достаточно).

Настрой SSH, чтобы git использовал этот ключ:

```bash
# ~/.ssh/config на сервере
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/dashboard_deploy
  IdentitiesOnly yes
EOF
```

## Шаг 2. SSH-доступ для GitHub Actions

Сгенерируй ключ, которым **Actions** будет заходить на сервер (на своей машине):

```bash
ssh-keygen -t ed25519 -f dashboard_ci -N ""
# публичный ключ -> на сервер
ssh-copy-id -i dashboard_ci.pub user@SERVER_IP
# приватный ключ dashboard_ci -> в секреты GitHub (см. ниже)
```

## Шаг 3. Секреты в GitHub

**Репозиторий → Settings → Secrets and variables → Actions → New repository secret:**

| Секрет            | Значение                                  | Обязательный |
| ----------------- | ----------------------------------------- | ------------ |
| `SSH_HOST`        | IP сервера Hetzner                        | да           |
| `SSH_USER`        | пользователь SSH (напр. `root` или `deploy`) | да         |
| `SSH_PRIVATE_KEY` | содержимое файла `dashboard_ci` (приватный) | да         |
| `SSH_PORT`        | порт SSH, если не 22                      | нет          |
| `DEPLOY_PATH`     | путь на сервере, по умолчанию `/opt/my_dashboard` | нет     |

## Шаг 4. Запуск

```bash
git push origin main
```

Дальше деплой автоматический. Можно также запустить вручную: **Actions → Deploy to server → Run workflow**.

## Что делает workflow

1. Заходит на сервер по SSH.
2. Клонирует репозиторий (первый раз) или делает `git reset --hard origin/main`.
3. `docker compose up -d --build` — пересобирает и перезапускает дашборд.
4. Чистит старые образы.
