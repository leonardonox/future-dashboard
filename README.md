# Dashboard Comparativo de Vendas

## Rodar local

```bash
npm install
npm start
```

Acesse: http://localhost:3000/login

Sem `DATABASE_URL`, o projeto usa `sheets.json` como fallback local.

## Render com PostgreSQL

O jeito mais simples é subir este projeto para o GitHub e criar um Blueprint no Render usando o arquivo `render.yaml`.

O Render vai criar:

- Web Service: `vina-dashboard`
- PostgreSQL: `vina-dashboard-db`
- Variável `DATABASE_URL` ligada automaticamente ao banco

Configuração equivalente, caso faça manualmente:

- Build Command: `npm install`
- Start Command: `npm start`
- Environment Variable: `DATABASE_URL` com a connection string interna do PostgreSQL

Quando `DATABASE_URL` existir, o servidor cria automaticamente a tabela `dashboard_state` e salva a Base de dados no PostgreSQL.

## Conferir armazenamento

Abra:

`/api/storage`

Ele retorna `mode: "postgres"` quando o banco está ativo, ou `mode: "json"` quando está usando fallback local.
