# Cofre

PWA + servidor Node para juntar mídias em **pastas** e mandar para o **Bunny**.

Você cola (ou compartilha do celular) links de álbuns do erome numa pasta. O servidor baixa as mídias, e daí você edita (recorta, corta a duração, borra, transforma foto em vídeo), envia ao Bunny uma por uma ou em lote e libera o espaço da VPS. A pasta continua no sistema para você ir alimentando.

## Fluxo
1. **Crie uma pasta** (ex.: "Criativos de imagem").
2. **Cole os links**. Pode colar vários de uma vez, um por linha ou misturados num texto.
3. Embaixo de cada mídia ficam **✎ Editar** e **↑ Bunny**. O download fica no menu **⋯**.
4. **Selecionar**: marque uma por uma ou use "Selecionar todas" (respeita a busca e os filtros), e depois escolha Enviar ao Bunny, Mover, .zip, Tentar de novo ou Apagar.
5. **Liberar espaço**: apaga da VPS só o que foi **conferido no Bunny naquele momento**. A miniatura e o registro continuam na aba "No Bunny", com o link.

## Para onde vai no Bunny
| Pasta | Destino |
|---|---|
| Tem fotos (ou fotos e vídeos) | **Storage**, em `/<nome-da-pasta>/arquivo` |
| Só vídeos | **Stream**, numa coleção com o nome da pasta |

Isso é o modo **automático** (padrão). No menu ⋯ da pasta dá para forçar Storage ou Stream. Fotos sempre vão para o Storage, porque o Stream só aceita vídeo.

### Como o sistema garante que o arquivo chegou
- **Storage:** cada envio leva o SHA256 do arquivo (`Checksum`), e o Bunny recusa se o arquivo chegar diferente. Depois o sistema lista a pasta no Bunny e confere nome e tamanho.
- **Stream:** o arquivo só é marcado "✓ No Bunny" quando o Bunny termina de processar o vídeo (status *Finished*).
- **Liberar espaço:** confere tudo **de novo** antes de apagar. Se algum arquivo sumiu ou está diferente no Bunny, ele **não** é apagado e volta a mostrar erro, para você reenviar.

## Travas da VPS
Todas as tarefas pesadas passam por filas com limite **global**. Por exemplo, com 50 arquivos em 5 álbuns, nunca mais que `DOWNLOAD_CONCURRENCY` baixam ao mesmo tempo. Quando um termina, o próximo começa.
- Download parado (sem receber dados) é cancelado depois de `STALL_TIMEOUT_SEC` e tentado de novo, sem travar a fila.
- Se o link da mídia expirou, o sistema relê a página do álbum e tenta com o link novo.
- Com menos de `MIN_FREE_GB` livres, downloads e edições **pausam sozinhos** e aparece um aviso no app.
- O ffmpeg roda com prioridade baixa (`nice`) e limitado a `FFMPEG_THREADS` núcleos.

## Deploy no EasyPanel
1. App com fonte GitHub e build por **Dockerfile**.
2. **Mounts:** um **Volume** em `/data`. Esse volume guarda os arquivos **e o banco** (`/data/cofre.db`, SQLite), então não precisa criar um serviço de banco.
3. **Environment:** copie o `.env.example` e preencha `APP_PIN` e os dados do Bunny.
4. Domínio com HTTPS na porta 3000.

Na primeira vez que sobe, a versão nova **converte os álbuns antigos** para uma pasta "Importados". A pasta antiga é renomeada para `albums.antigo-…`; pode apagar depois de conferir.

## Instalar no celular
- **Android (Chrome):** menu ⋮ → *Instalar app*. Depois disso o Cofre aparece no **Compartilhar**.
- **iPhone (Safari):** Compartilhar → *Adicionar à Tela de Início* (use o botão Colar).

## Rodar local / testes
```
npm install
APP_PIN=1234 DATA_DIR=./data npm start   # http://localhost:3000
npm test                                  # fluxo completo com erome e Bunny simulados (precisa de ffmpeg)
```
