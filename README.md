# diário (app)

App estático do meu diário, servido pelo GitHub Pages. **Este repo não contém
nenhuma entrada.** O texto fica num repo privado separado e o app o lê e grava pela
API do GitHub, com um token fine-grained que fica só no navegador (localStorage).

- `index.html`, `app.js`, `style.css`: SPA sem build. Telas: escrever (rascunho salvo
  a cada tecla, Ctrl+Enter guarda), pensamentos (Tudo/Trabalho/Pessoal, tags, busca),
  pensamento (pensamentos próximos, editar/apagar) e configuração.
- `constellation.js`: a constelação em canvas. Estrelas = pensamentos (cor = área),
  linhas = afinidade semântica, nebulosas = clusters nomeados pela IA; modo Tags com
  coocorrência, lift, humor médio e divisão trabalho/pessoal por tag.
- `ambient.js`: o fundo de poeira de estrelas que reage ao cursor.
- `vendor/d3-7.9.0.min.js`: d3 servido daqui, não de um CDN (a página guarda o token).

Os metadados (`index.json`) e o grafo (`graph.json`) são gerados por uma GitHub Action
no repo de dados.
