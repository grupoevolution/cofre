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

## Sites que pedem login (Instagram, X, OnlyFans…)
Exporte os cookies do navegador no formato `cookies.txt` (extensão "Get cookies.txt LOCALLY") e salve em `/data/cookies.txt` no volume. Para o erome, também dá para usar `EROME_COOKIE`.

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
