# Draven Sports · CRM com WhatsApp por QR Code

É o mesmo CRM da Draven: funil, clientes 360°, campanhas, NPS, vendas, produção, estoque, relatórios e o layout da loja. Esta versão roda num servidor próprio e acrescenta:

- **Conexão do WhatsApp por QR Code**, como no WhatsApp Web. Você pode conectar um ou mais números, por exemplo um para cada vendedor.
- **Entrada automática no funil:** quem mandar mensagem vira lead em "Novo lead", já com canal, tipo de cliente, interesse e responsável preenchidos.
- **Aba Conversas:** a equipe responde pelo próprio CRM e cada mensagem fica guardada com o cliente.
- **Login da equipe** com os perfis Gestão, Vendas e Estoque. A gestão pode criar as contas dos funcionários e gerar senhas novas.
- **Permissões conferidas no servidor:** cada perfil só lê e grava o que a tela dele permite, mesmo em chamadas diretas ao sistema.

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
cp .env.example .env        # preencha OWNER_EMAIL com o seu e-mail
docker compose up -d --build
```

Depois, acesse `http://IP-DO-SERVIDOR:3000`. Para usar com domínio próprio e cadeado (https), coloque na frente um proxy como Caddy ou Nginx, ou use o Cloudflare Tunnel.

### Opção B: Railway ou Render

1. Crie um projeto novo e envie esta pasta (por GitHub ou upload).
2. Ele detecta o `Dockerfile` sozinho.
3. Adicione um **volume ou disco persistente** montado em `/app/data`.
4. Em variáveis de ambiente, defina `PORT=3000`, `OWNER_EMAIL=seu@email.com` e `TRUST_PROXY=1`. Essas plataformas ficam atrás de um proxy.
5. Abra o endereço que a plataforma gerar.

### Opção C: Node.js direto (sem Docker)

Requer o Node 22.13 ou mais novo e o Git instalados.

```bash
npm install
npm start
```

---

## 2. Primeiro acesso

1. **Antes de colocar o endereço na internet**, preencha `OWNER_EMAIL` no `.env` com o seu e-mail. Só esse e-mail consegue fazer o primeiro acesso, que vira a conta **dona do sistema** (perfil Gestão). Se `OWNER_EMAIL` ficar vazio, a primeira conta criada vira a dona, e o servidor avisa isso ao ligar.
2. Para colocar a equipe, há dois caminhos (os dois funcionam ao mesmo tempo):
   - **A gestão cria a conta:** em **Equipe e permissões**, clique em **Cadastrar funcionário**. Informe nome, e-mail, perfil, cargo e telefone. A senha é gerada na hora e pode ser copiada ou enviada pelo WhatsApp. O botão **Nova senha** gera outra senha quando alguém esquecer; a antiga deixa de valer e a pessoa sai de todos os aparelhos.
   - **A pessoa cria a própria conta:** mande o endereço do sistema. Ela aparece em **Pedidos de acesso**, onde você escolhe o perfil. Até lá, ela não vê nenhum dado, nem a lista da equipe.
3. Se preferir que só a gestão crie contas, defina `ALLOW_SIGNUP=false` no `.env`.

### Segurança do login

- Cada e-mail aceita até 10 senhas erradas a cada 15 minutos. Depois disso, espere ou peça para a gestão gerar uma senha nova.
- Cada endereço de internet (IP) aceita até 12 tentativas por minuto. Com `TRUST_PROXY=1`, o sistema usa o IP informado pelo proxy. Ligue essa opção **só** se houver um proxy na frente (Railway, Render, Caddy, Nginx, Cloudflare Tunnel). Sem proxy, deixe vazio: assim ninguém consegue fingir outro IP para driblar o limite.

---

## 3. Conectar o WhatsApp

1. Entre na aba **WhatsApp** e clique em **Conectar número**.
2. Dê um nome ao número (por exemplo, "Comercial · Juliana") e escolha o **responsável** pelos leads que chegarem por ele.
3. Aparece um QR Code. No celular desse número:
   - **Android:** WhatsApp, depois ⋮, depois **Aparelhos conectados**, depois **Conectar um aparelho**.
   - **iPhone:** WhatsApp, depois **Configurações**, depois **Aparelhos conectados**, depois **Conectar um aparelho**.
4. Aponte a câmera para o QR Code. Em alguns segundos o status muda para **Conectado**.

O celular pode continuar sendo usado normalmente. As mensagens chegam nele e no CRM ao mesmo tempo. Se o QR Code expirar, clique em **Gerar QR Code** de novo.

**Conversas que a equipe começa pelo celular:** por padrão, quando alguém da equipe manda mensagem do celular para um número que não está no CRM, esse número também vira lead. Se o número conectado também conversa com fornecedores ou contatos pessoais, desmarque **Criar lead também quando a equipe inicia a conversa pelo celular** no cartão do número. Essas conversas continuam aparecendo em **Conversas**, com o botão **Adicionar ao funil** para cadastrar o contato quando fizer sentido. Mensagens que o contato mandar continuam criando lead normalmente.

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
- O sistema usa a versão **7.0.0-rc14** da biblioteca Baileys, fixada no `package.json`. É a versão que informa o telefone verdadeiro dos contatos que o WhatsApp passou a esconder atrás de um código (os chamados LID). Na versão 6, esses contatos entrariam sem telefone.
- Se o WhatsApp mudar algo e a conexão parar de funcionar, procure a versão mais nova da Baileys, troque o número da versão no `package.json` e reinicie:
  - com Node: `npm install`
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
- **Esqueceu a senha:** a gestão gera uma nova em **Equipe e permissões**, no botão **Nova senha**. Se for a senha do dono, rode no servidor `node server.mjs --senha email@empresa.com NovaSenha123` e reinicie o sistema.
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
