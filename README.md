# diário (app)

App estático do meu diário, servido pelo GitHub Pages. **Este repo não contém
nenhuma entrada.** O texto fica num repo privado separado e o app o lê e grava pela
API do GitHub, com um token fine-grained que fica só no navegador (localStorage).

- `index.html`, `app.js`, `style.css`: SPA sem dependências nem build.
- Telas: escrever (rascunho salvo localmente a cada tecla, Ctrl+Enter salva),
  entradas (busca + filtros por tag/pessoa/lugar/tipo), entrada (editar/apagar), tags.
- Título, resumo, tags, humor, pessoas e lugares são gerados por uma GitHub Action
  no repo de dados, que grava um `index.json` lido aqui.
