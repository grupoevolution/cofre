# Cofre

PWA + servidor Node para baixar vídeos e fotos de **qualquer site**, organizar em pastas e enviar para o Bunny quando você quiser.

## O que faz
- **Cola um ou vários links de uma vez** (um por linha) ou usa o "Compartilhar → Cofre" no Android.
- **Qualquer site:** erome (leitor próprio, inclusive **perfil inteiro**) → yt-dlp (≈1.800 sites de vídeo) → gallery-dl (fotos/álbuns) → leitura da página (último recurso). Os motores se atualizam sozinhos 1x por dia.
- **Biblioteca** com **pastas suas**, busca e filtros: foto/vídeo, em pé/deitado/quadrado, duração, HD, site, "já usei", "no Bunny".
- **Seleção múltipla** (botão Selecionar ou segurar o dedo num arquivo): mover/adicionar a pasta, baixar .zip, enviar pro Bunny, copiar links do Bunny, marcar usado, liberar espaço, apagar.
- **Bunny manual:** botão no arquivo, na seleção ou na pasta inteira. O arquivo ganha selo ☁ e o botão "copiar link".
- **Liberar espaço:** apaga do servidor o que já está no Bunny (continua aparecendo no app, vindo do Bunny).
- **Anti-duplicado:** arquivo idêntico que já existe na biblioteca é descartado e avisado.
- **Limpeza de dados escondidos:** câmera, GPS, data e títulos embutidos são removidos ao baixar.
- **Espaço em disco** no topo, com aviso quando estiver acabando.
- Downloads com limite de tempo: um link travado não trava a fila. Se o servidor reiniciar, retoma sozinho.

### Novidades 2.2 (arsenal)
- **Atividade ao vivo:** cada download mostra etapa, %, velocidade, tempo restante e um diário; envios pro Bunny também. Aviso no navegador (🔔) quando termina.
- **Direto pro Bunny:** no campo de colar, escolha "Direto pro Bunny" + a pasta (lista as pastas que já existem ou cria uma nova). Baixa, envia e apaga do servidor (ou mantém cópia, se marcar).
- **Etapas do arsenal:** Bruto → Separado → No Bunny → Usado, com contador e filtro. **Favoritos ⭐.**
- **Legendas automáticas** (loira, morena, ruiva, magra, quarto, selfie…) feitas no próprio servidor por um modelo de visão local (CLIP). Dá para editar, adicionar as suas e filtrar. Desligar: `AUTO_TAGS=0`. Usa ~0,5–1 GB de RAM enquanto legenda.
- **Pasta = persona (👤):** marque uma pasta como persona; o Cofre avisa se um arquivo já é (ou já foi usado) em outra persona, e guarda "usado em".
- **Vídeo longo:** prévia de 24 cenas ao passar o mouse/dedo na miniatura e **cortar trecho** no visualizador (Início/Fim → vira um arquivo novo).
- **Quase-duplicado:** a mesma foto/vídeo em outro tamanho ou recompressão é marcada como "parecida" (filtro "Só os parecidos") para você manter os dois ou apagar.

## Deploy no EasyPanel
1. App com fonte GitHub e build por **Dockerfile**.
2. Variáveis de ambiente: `APP_PIN` e `APP_SECRET` (obrigatórias: **sem PIN o Cofre fica bloqueado**) e as do Bunny. Veja `.env.example`.
3. Em **Mounts**, crie um **Volume** em `/data`. Sem isso, os arquivos somem a cada deploy.
4. Domínio com HTTPS na porta 3000 (obrigatório para instalar como app).

## Bunny
- `BUNNY_STORAGE_ZONE` e `BUNNY_STORAGE_KEY`: nome e senha da storage zone (Storage → zona → FTP & API Access).
- `BUNNY_CDN_URL`: endereço da Pull Zone ligada a ela (ex.: `https://minhazona.b-cdn.net`).
- `BUNNY_STORAGE_HOST`: só se a zona não for de Falkenstein (ex.: `br.storage.bunnycdn.com`).
- Os arquivos vão para `cofre/<pasta que você digitar>/<id>-<arquivo>`.

## Como ele tenta baixar um link
1. **Link direto** (.mp4, .jpg…) → baixa na hora.
2. **yt-dlp** → ≈1.800 sites de vídeo (inclui perfis e playlists).
3. **gallery-dl** → fotos e álbuns (Reddit, Imgur, Instagram, coomer…).
4. **Leitura da página** → `<video>`, og:video e links para arquivos.
5. **Navegador invisível** (Chromium no servidor) → abre a página, dá play e pega o vídeo que o próprio site carrega. Último recurso, um por vez.

Em cada etapa: se o site **bloquear o servidor** (403/429/"not a bot"), tenta de novo pelo **proxy** (se configurado).
Se nada der certo, o app mostra **o que houve + o que fazer** (ex.: "O site pediu login → suba os cookies em Contas").

## Contas (sites que pedem login: Instagram, OnlyFans, Privacy, X…)
Aba **Contas** no app: no Chrome do PC, instale a extensão **Get cookies.txt LOCALLY** (ou **Cookie-Editor**), entre logado no site, exporte e cole/envie no Cofre. Downloads que tinham falhado por login naquele site voltam para a fila sozinhos. Use uma conta secundária. Os valores dos cookies nunca saem do servidor pela API.

## Proxy (sites que bloqueiam o servidor, ex.: YouTube)
`PROXY_URL=http://usuario:senha@host:porta` (proxy residencial). `PROXY_MODE=fallback` (padrão: só quando bloquear) ou `always`.

## O que não dá para baixar
Vídeo com proteção anticópia (DRM): Netflix, Prime, Disney+, Globoplay e afins. O Cofre avisa e não tenta.

## Instalar no celular
- **Android (Chrome):** menu ⋮ → *Instalar app*. Depois o Cofre aparece no **Compartilhar**.
- **iPhone (Safari):** Compartilhar → *Adicionar à Tela de Início* e use o botão **Colar**.

## Rodar local / testar
```
npm install
APP_PIN=1234 DATA_DIR=./data npm start   # http://localhost:3000
npm test                                  # teste de ponta a ponta (precisa de ffmpeg)
```

## Se parar de funcionar
- **Um site específico parou:** normalmente o yt-dlp/gallery-dl já corrigiu; o servidor atualiza sozinho em até 24 h (ou reinicie o app).
- **"site não suportado":** nenhum motor reconhece o link. Tente o link direto do post/vídeo.
- **"o site pediu login":** coloque o `cookies.txt` (veja acima).
- **erome "Nenhum vídeo ou imagem encontrado":** o erome mudou o HTML, ou o álbum é privado/removido. O leitor fica em `lib/erome.js` (`parseAlbum`).
