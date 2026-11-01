# Draven Sports · CRM com WhatsApp por QR Code

É o mesmo CRM da Draven: funil, clientes 360°, campanhas, NPS, vendas, produção, estoque, relatórios e o layout da loja. Esta versão roda num servidor próprio e acrescenta:

- **Conexão do WhatsApp por QR Code**, como no WhatsApp Web. Você pode conectar um ou mais números, por exemplo um para cada vendedor.
- **Entrada automática no funil:** quem mandar mensagem vira lead em "Novo lead", já com canal, tipo de cliente, interesse e responsável preenchidos.
- **Aba Conversas:** a equipe responde pelo próprio CRM e cada mensagem fica guardada com o cliente.
- **Login da equipe** com os perfis Gestão, Vendas e Estoque.

---

## 1. Onde colocar no ar

O sistema precisa ficar ligado 24 horas, porque só assim recebe as mensagens do WhatsApp. As opções mais simples:

| Opção | Custo aproximado | Para quem |
|---|---|---|
| **Railway** ou **Render** (com disco persistente) | a partir de US$ 5 a 7 por mês | Quem não quer cuidar de servidor |
| **VPS** (Hostinger, DigitalOcean, Contabo, Magalu Cloud) com Docker | a partir de cerca de R$ 30 por mês | Quem tem alguém de TI por perto |
| Um computador da empresa que fica sempre ligado | sem custo extra | Só para testar |

> O importante é que a pasta `data` fique num **disco persistente**. É nela que ficam o banco de dados e as sessões do WhatsApp. Sem ela, tudo se perde quando o servidor reinicia.

### Opção A: VPS ou computador com Docker

```bash
# na pasta do projeto
cp .env.example .env        # ajuste o arquivo se quiser
docker compose up -d --build
```

Depois, acesse `http://IP-DO-SERVIDOR:3000`. Para usar com domínio próprio e cadeado (https), coloque na frente um proxy como Caddy ou Nginx, ou use o Cloudflare Tunnel.

### Opção B: Railway ou Render

1. Crie um projeto novo e envie esta pasta (por GitHub ou upload).
2. Ele detecta o `Dockerfile` sozinho.
3. Adicione um **volume ou disco persistente** montado em `/app/data`.
4. Em variáveis de ambiente, defina pelo menos `PORT=3000`.
5. Abra o endereço que a plataforma gerar.

### Opção C: Node.js direto (sem Docker)

Requer o Node 22.13 ou mais novo e o Git instalados.

```bash
npm install
npm start
```

---

## 2. Primeiro acesso

1. Abra o endereço do sistema. A primeira conta criada vira a **administradora** (perfil Gestão).
2. Para colocar a equipe: mande o endereço do sistema para a pessoa e peça para ela criar a conta. Ela aparece em **Equipe e permissões**, onde você escolhe o perfil dela: Vendas, Estoque ou Gestão.
3. Quando todos tiverem conta, defina `ALLOW_SIGNUP=false` no `.env` para fechar novos cadastros.

---

## 3. Conectar o WhatsApp

1. Entre na aba **WhatsApp** e clique em **Conectar número**.
2. Dê um nome ao número (por exemplo, "Comercial · Juliana") e escolha o **responsável** pelos leads que chegarem por ele.
3. Aparece um QR Code. No celular desse número:
   - **Android:** WhatsApp, depois ⋮, depois **Aparelhos conectados**, depois **Conectar um aparelho**.
   - **iPhone:** WhatsApp, depois **Configurações**, depois **Aparelhos conectados**, depois **Conectar um aparelho**.
4. Aponte a câmera para o QR Code. Em alguns segundos o status muda para **Conectado**.

O celular pode continuar sendo usado normalmente. As mensagens chegam nele e no CRM ao mesmo tempo. Se o QR Code expirar, clique em **Gerar QR Code** de novo.

### Como cada contato é classificado

| Situação | O que o CRM faz |
|---|---|
| Número novo | Cria um lead em **Novo lead**, com canal WhatsApp, o número de entrada, o responsável do número e a próxima ação "Responder mensagem recebida". O **tipo de cliente** (academia, escolinha, equipe, loja, distribuidor, atleta) e o **interesse** (luvas, kimonos, goleiro, marca própria etc.) saem do nome do perfil e da primeira mensagem. |
| Já está no CRM | Liga a conversa ao cadastro existente. O telefone é comparado com e sem o nono dígito, então ninguém é cadastrado duas vezes. A mensagem entra na linha do tempo. |
| Cliente ativo | Continua como cliente ativo e ganha a próxima ação "verificar novo pedido". |
| Marcado como perdido | Volta para **Primeiro contato**, com uma anotação de que retomou a conversa. |
| Grupos, status e canais | São ignorados. |

Com a IA ligada (veja abaixo), cada lead novo também recebe um resumo do que quer e uma estimativa de potencial de compra. Essa estimativa alimenta o valor do pipeline.

Tudo isso aparece no **Funil CRM** (filtro por canal), no **Painel** (follow-ups do dia) e em **Relatórios e BI** (leads por canal e por número de WhatsApp, e quantos viraram clientes).

### Cuidados importantes

- A conexão por QR Code **não é a API oficial** do WhatsApp. Ela funciona como o WhatsApp Web, mas o WhatsApp pode bloquear números que mandam muitas mensagens para quem não os conhece. Use números dedicados ao comercial e evite disparos em massa.
- Abra o WhatsApp no celular pelo menos uma vez a cada 14 dias. Se ficar muito tempo sem uso, o WhatsApp desconecta os aparelhos vinculados.
- Se o WhatsApp mudar algo e a conexão parar de funcionar, atualize a biblioteca e reinicie:
  - com Node: `npm install @whiskeysockets/baileys@latest`
  - com Docker: `docker compose up -d --build`

---

## 4. Inteligência artificial (opcional)

Coloque uma chave da API da Anthropic no `.env` (crie em https://console.anthropic.com):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Isso liga quatro recursos: o "Escrever com IA" nas campanhas, a análise dos comentários do NPS, a classificação automática dos leads do WhatsApp e o resumo de cada contato. O uso é cobrado pela Anthropic, conforme o consumo.

---

## 5. Backup e manutenção

- **Backup:** copie a pasta `data` inteira. Ela contém o banco (`draven.db`) e as sessões do WhatsApp (`wa/`).
- **Esqueceu a senha:** no servidor, rode `node server.mjs --senha email@empresa.com NovaSenha123` e reinicie o sistema.
- **Importar dados:** rode `node server.mjs --importar arquivo.json`. O arquivo segue o formato `{ "clientes": [ { "id": "...", "data": { ... } } ], ... }`.
- **Teste sem celular:** `npm run teste` liga um WhatsApp simulado, só para conferir as telas.

## 6. Arquivos

```
server.mjs        servidor: login, banco, tempo real, rotas
whatsapp.mjs      conexão por QR Code, classificação dos contatos e envio de mensagens
public/index.html interface do CRM
public/shim.js    ponte entre a interface e o servidor
public/login.html tela de entrada
data/             banco e sessões (criada automaticamente, faça backup)
```
