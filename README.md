# Cofre — salvar álbuns do erome

PWA + servidor Node. Você cola (ou compartilha) o link de um álbum do erome no celular. O servidor baixa todos os vídeos e fotos para uma pasta por álbum, e você acessa e baixa tudo pelo navegador do computador.

## Como funciona
- O servidor abre a página se identificando como celular (o erome libera acesso para mobile) e lê cada post (`media-group`) do álbum.
- Baixa os arquivos enviando o `Referer` do erome (sem ele, o servidor de mídia recusa), 3 em paralelo e com 3 tentativas cada.
- Salva em `/data/albums/<id-do-album>/001.mp4, 002.jpg…` junto com um `meta.json`. Os vídeos ganham miniatura (gerada com ffmpeg).
- No app você tem a lista de álbuns, um visualizador, download por arquivo e o botão **Baixar tudo (.zip)**, que já entrega a pasta com o nome `autor_titulo_id`.
- Se o servidor reiniciar no meio de um download, ele retoma sozinho.

## Deploy no EasyPanel
1. Suba esta pasta num repositório **privado** do GitHub.
2. No EasyPanel, crie um novo App com fonte GitHub e build por **Dockerfile**.
3. Defina as variáveis de ambiente `APP_PIN` e `APP_SECRET` (veja `.env.example`).
4. Em **Mounts**, crie um **Volume** apontando para `/data`. Sem isso, os arquivos somem a cada deploy.
5. Configure um domínio com HTTPS (ex.: `cofre.seudominio.com`) na porta 3000. O HTTPS é obrigatório para instalar como app.

## Instalar no celular
- **Android (Chrome):** abra o domínio e toque em menu ⋮ → *Instalar app*. Depois disso o Cofre aparece no menu **Compartilhar**: com um álbum aberto no erome, toque em Compartilhar → Cofre e ele já entra na fila.
- **iPhone (Safari):** toque em Compartilhar → *Adicionar à Tela de Início*. No iPhone, PWAs não aparecem no menu de compartilhar, então use o botão **Colar**.

## Rodar local (teste)
```
npm install
APP_PIN=1234 DATA_DIR=./data npm start   # http://localhost:3000
```

## Se parar de funcionar
- **"Nenhum vídeo ou imagem encontrado":** o erome mudou o HTML, ou o álbum é privado ou foi removido. O leitor da página fica em `lib/erome.js` (`parseAlbum`).
- **Erro 403 ao abrir o álbum:** o IP do servidor pode estar bloqueado, ou o site passou a exigir cookie. Nesse caso, preencha `EROME_COOKIE`.
