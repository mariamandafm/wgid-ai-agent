# Gerenciamento de Identidade de Agentes de IA em Federações — Documentação Técnica

> **Experimento** desenvolvido no contexto do GIdLab  para demonstrar como identidades federadas via CAFe podem ser delegadas a agentes de inteligência artificial utilizando protocolos e recomendações atuais.

---

## Sumário

1. [Visão Geral](#1-visão-geral)
2. [Arquitetura](#2-arquitetura)
3. [Pré-requisitos](#3-pré-requisitos)
4. [Configuração do Ambiente](#4-configuração-do-ambiente)
5. [Fluxo da Demonstração](#5-fluxo-da-demonstração) ([detalhamento técnico](docs/fluxo-tecnico.md))
6. [Protocolos e Recomendações Adotados](#6-protocolos-e-recomendações-adotados)

---

## 1. Visão Geral

### 1.1 Objetivo

Esta demonstração mostra como o gerenciamento de identidade de agentes de IA pode ser integrado ao ecossistema de federações de identidade acadêmicas — em particular à **Comunidade Acadêmica Federada (CAFe)** da RNP — utilizando protocolos abertos e recomendações em vigor.

O cenário central é: uma pesquisadora autenticada via federação CAFe autoriza um **agente de IA** a acessar dados científicos e submeter jobs em clusters HPC **em seu nome**, com escopos limitados e rastreabilidade completa.

### 1.2 Problema que a Demonstração Resolve

Agentes de IA precisam acessar recursos protegidos (APIs, dados, infraestrutura HPC) em nome de usuários reais. Sem um mecanismo de delegação padronizado, as alternativas comuns são inseguras:

| Abordagem insegura | Problema |
|---|---|
| Compartilhar credenciais do usuário com o agente | Viola o princípio do menor privilégio; sem rastreabilidade |
| Criar credenciais técnicas separadas para o agente | O agente age em nome próprio, não do usuário — sem identidade delegada |
| Copiar e colar tokens manualmente | Operacionalmente inviável; sem revogação |

Esta PoC demonstra que o **OAuth 2.0 Token Exchange (RFC 8693)** resolve esse problema: o agente recebe um token derivado das credenciais do usuário, com escopos reduzidos, rastreável e revogável, sem que o usuário precise compartilhar sua senha ou token primário.

### 1.3 Tecnologias e Protocolos

| Camada | Tecnologia |
|---|---|
| Federação de identidade | SATOSA 8.5.1 (proxy SAML2-to-SAML2) + Shibboleth IdP (CAFe) |
| Servidor de autorização | Keycloak 26.6.4 (Standard Token Exchange V2) |
| Portal de delegação | Node.js 22 + Express 4 + EJS |
| Agente de IA | Mastra v1.45.0 (TypeScript) |
| API protegida | Node.js 22 + Express 4 |
| Infraestrutura | Docker Compose |
| Protocolo de delegação | RFC 8693 — OAuth 2.0 Token Exchange |
| Verificação de revogação | RFC 7662 — OAuth 2.0 Token Introspection |
| Revogação de tokens | RFC 7009 — OAuth 2.0 Token Revocation |
| Autenticação federada | SAML 2.0 |
<!-- | Atributos federados | eduPersonEntitlement (AARC-G069) | -->

---

## 2. Arquitetura

### 2.1 Componentes

```mermaid
graph LR
    U(["👩‍🔬 Pesquisadora"])

    subgraph docker["Rede Docker"]
        P["Portal\n:3000"]
        AG["Agente\n:4111"]
        API["API Server\n:3001"]
        KC["Keycloak\n:8080"]
        SAT["SATOSA\n:443"]
    end

    subgraph cafe["CAFe / RNP"]
        IDP["Shibboleth IdP"]
    end

    U -- browser --> P
    P <--> AG
    AG <--> API
    API <--> KC
    P <--> KC
    KC -- SAML2 --> SAT
    SAT -- SAML2 --> IDP
```

#### Portal de Delegação (`portal/`)

Aplicação web Express que implementa o fluxo OAuth 2.0 do ponto de vista do usuário. Responsabilidades:

- Autenticar a pesquisadora via Keycloak (Authorization Code Flow)
- Descobrir dinamicamente os escopos que o agente necessita (via `GET /agent-info`)
- Apresentar tela de consentimento com seleção granular de escopos
- Executar o Token Exchange (RFC 8693) servidor-a-servidor
- Entregar o token delegado ao agente via push server-to-server autenticado
- Permitir revogação da delegação

#### Agente de IA (`agent/`)

Agente Mastra (TypeScript) que utiliza o token delegado para chamar a API. Responsabilidades:

- Expor endpoint `GET /agent-info` — autodescoberta de identidade e escopos
- Expor endpoint `POST /token` — receber token delegado do portal via push seguro
- Armazenar o token em `tokenStore` (memória volátil)
- Usar o token em todas as chamadas à API via ferramentas (`buscarSequencias`, `submeterJob`)

#### API Server (`api_server/`)

API Express que representa um serviço científico protegido. Responsabilidades:

- Validar cada requisição via **Token Introspection** (RFC 7662) no Keycloak
- Rejeitar tokens revogados ou expirados (`active: false`)
- Verificar escopos OAuth antes de executar cada operação
- Gravar log de auditoria de cada acesso

#### Keycloak

Servidor de autorização central. Responsabilidades:

- Autenticar usuários federados recebidos via SATOSA/SAML2
- Emitir tokens de acesso (Authorization Code Flow)
- Executar o Token Exchange (RFC 8693 Standard Token Exchange V2)
- Responder a consultas de introspection (`/token/introspect`)
- Processar revogações (`/revoke`)

#### SATOSA

Proxy de protocolo SAML2-to-SAML2. Responsabilidades:

- Receber asserções SAML2 do Shibboleth IdP da CAFe
- Traduzir e reencaminhar atributos para o Keycloak (atuando como SP perante o IdP e como IdP perante o Keycloak)
- Mapear `eduPersonEntitlement` e demais atributos federados


### 2.2 Fluxo de Comunicação

```mermaid
sequenceDiagram
    actor U as Pesquisadora
    participant P as Portal :3000
    participant KC as Keycloak :8080
    participant SAT as SATOSA :443
    participant IDP as Shibboleth IdP
    participant AG as Agente :4111
    participant API as API Server :3001

    U->>P: GET /
    P->>AG: GET /agent-info
    AG-->>P: {name, requestedScopes}
    P-->>U: Página inicial com agentes disponíveis

    U->>P: GET /consent/wgid-agent-v1
    P-->>U: Tela de consentimento (escopos pré-selecionados)

    U->>P: POST /authorize (login necessário)
    P-->>U: Redirect → Keycloak Auth
    U->>KC: Authorization Code Flow
    KC->>SAT: SAML2 AuthnRequest
    SAT->>IDP: SAML2 AuthnRequest (CAFe)
    IDP-->>SAT: Asserção SAML2 (atributos federados)
    SAT-->>KC: Asserção SAML2 (atributos mapeados)
    KC-->>U: Authorization Code
    U->>P: GET /callback?code=...
    P->>KC: POST /token (code → access_token)
    KC-->>P: {access_token: <token-usuaria>}

    Note over P,KC: Token Exchange — RFC 8693
    P->>KC: POST /token (client_credentials → actor_token)
    KC-->>P: {access_token: <actor_token>}
    P->>KC: POST /token (token-exchange: subject+actor)
    KC-->>P: {access_token: <delegated_token>}

    P->>AG: POST /token {token: <delegated_token>}
    AG-->>P: {ok: true}
    P-->>U: Tela de sucesso (payload decodificado)

    Note over U,API: Uso do token delegado pelo agente
    U->>AG: "Busque sequências do dataset WGID-001"
    AG->>API: GET /api/datasets/WGID-001/sequences<br/>Authorization: Bearer <delegated_token>
    API->>KC: POST /introspect (token)
    KC-->>API: {active: true, sub: ..., scope: ...}
    API-->>AG: {sequencias: [...]}
    AG-->>U: Resposta com dados

    Note over U,KC: Revogação
    U->>P: POST /revoke
    P->>KC: POST /revoke (token)
    KC-->>P: {} (aceito)
    P-->>U: Redirect → /
```

---

## 3. Pré-requisitos

### 3.1 Softwares Necessários

| Software | Versão mínima | Finalidade |
|---|---|---|
| Docker | 24.x | Orquestração de contêineres |
| Docker Compose | 2.x (plugin) | Subir todos os serviços |
| Node.js | 22.13.0 | Desenvolvimento local (portal, api_server, agente) |

> **Nota:** Node.js só é necessário para desenvolvimento local fora do Docker. Para rodar a PoC completa, apenas Docker e Docker Compose são obrigatórios.

### 3.2 Conta de API de LLM

O agente utiliza o modelo `google/gemini-2.5-flash`. É necessária uma **Google Gemini API Key** para que o agente processe mensagens.

### 3.3 Dependências de Rede

- Porta **3000** (Portal)
- Porta **3001** (API Server)
- Porta **4111** (Agente Mastra)
- Porta **8080** (Keycloak)
- Porta **443** (SATOSA — opcional, necessário apenas para integração CAFe)

---

## 4. Configuração do Ambiente


> [!WARNING]  
> Os arquivos de configuração possuem chaves e tokens públicamente configurados apenas para agilizar a instalação da demonstração.

### 4.1 Obter o Código-Fonte

```bash
git clone https://github.com/mariamandafm/wgid-ai-agent wgid
cd wgid
```

### 4.2 Configurar Variáveis de Ambiente

Cada serviço possui seu próprio arquivo `.env`. **Nunca commite esses arquivos** — o `.gitignore` já os exclui.

```bash
cp api_server/.env.example api_server/.env
cp agent/.env.example agent/.env
cp satosa/.satosa_env.example satosa/.satosa_env
cp portal/.env.example portal/.env
```


### 4.3 Inicializar os Serviços

```bash
# Primeira execução (ou após mudanças de código)
docker compose up --build

# Execuções subsequentes
docker compose up -d
```

### 4.4 Acessar os Serviços

| Serviço | URL | Credenciais |
|---|---|---|
| Portal de Delegação | `http://localhost:3000` | — |
| Keycloak Admin | `http://localhost:8080` | `admin` / `admin` |
| Mastra Studio (dev) | `http://localhost:4111` | — |
| API Server (health) | `http://localhost:3001/health` | — |
| Audit Log | `http://localhost:3001/audit` | — |

---

### 4.5 Configuração do Agente
Em `agente/.env` é preciso informar as chaves geradas pelo Google Gemini API Key

```
# Google Gemini API Key
GOOGLE_API_KEY=<sua-chave-google-gemini>
```

### 4.6 Configurar o Keycloak

> Ao subir com `docker compose up`, o Keycloak importa
> `keycloak/realm-import.json` no boot (`--import-realm`) e cria o realm, os 3
> clients, os client scopes e os audience mappers descritos abaixo, nenhuma
> configuração manual é necessária. Os secrets dos clients confidenciais já
> vêm pré-preenchidos nos `.env.example` (`wgid-agent-v1-dev-secret` e
> `api-server-dev-secret`), então `cp .env.example .env` já funciona sem
> editar nada.

Acesse `http://localhost:8080` (após subir o Keycloak) com as credenciais `admin/admin`.

O Keycloak possui as seguintes configurações:

#### Realms

* `agents`

#### Clients

* `delegation-portal` (portal)
  * Possui o `wgid-agent-v1` configurado como audience.

* `wgid-agent-v1` (agente)
  * Possui o Token Exchange habilitado e o `api-server` como audience.

* `api-server` (API)
  * Apenas para Token Introspection, não precisa de flows habilitados

#### Scopes OAuth

| Nome | Tipo |
|---|---|
| `genomica:read` | Optional |
| `hpc:submit` | Optional |

Ambos são optional scopes do client `wgid-agent-v1`.

#### Integração com SATOSA

Para que o Keycloak aceite autenticação via SATOSA, é necessário cadastrar o SATOSA como Identity Provider no Keycloak e trocar os metadados SAML2 entre os dois.

**1. Criar o IdP no Keycloak**

1. Baixe os metadados do IdP do SATOSA em `https://localhost/Saml2IDP/proxy.xml`.
2. No Keycloak, acesse **Identity providers > SAML v2.0**.
3. Preencha:
   * **Display Name:** `Federação`
   * Desabilite **Use entity descriptor**.
4. Com a opção desabilitada, o campo **Import config from file** aparece — selecione o arquivo `proxy.xml` baixado no passo 1. Os demais campos do IdP são preenchidos automaticamente a partir do metadado.
5. Marque **Want AuthnRequests signed**, **Want Assertions signed** e **Want Assertions encrypted**.
6. Clique em **Add**.
   
**2. Configurar os mappers no Keycloak**

Em **Identity providers > Federação > Mappers > Add mapper**, crie um mapper de importação de atributo para cada atributo abaixo:

| Name | Sync mode override | Mapper type | Friendly Name | User Attribute Name |
|---|---|---|---|---|
| Mail | Import | Attribute Importer | `mail` | `email` |
| Name | Import | Attribute Importer | `givenName` | `firstName` |
| LastName | Import | Attribute Importer | `sn` | `lastName` |

**3. Exportar os metadados do Keycloak para o SATOSA**

1. Os metadados do Keycloak ficam disponíveis em `http://localhost:8080/realms/agents/broker/saml/endpoint/descriptor`.
2. Baixe esse metadado e salve em `satosa/volumes/keycloak.xml`.


### 4.7 Configurar o SATOSA (Integração CAFe)

O SATOSA atua como SP perante o Shibboleth IdP da CAFe e como IdP perante o Keycloak.

```
satosa/volumes/
├── proxy_conf.yaml          # Configuração principal (BASE URL, plugins)
├── internal_attributes.yaml # Mapeamento de atributos (inclui eduPersonEntitlement)
├── plugins/
│   ├── backends/
│   │   └── saml2_backend.yaml   # Configuração do SP (consome assertções do IdP CAFe)
│   └── frontends/
│       └── saml2_frontend.yaml  # Configuração do IdP virtual (serve o Keycloak)
└── metadata/                # Metadados SAML2 do IdP CAFe
```

**1. Configurar os Plugins**

* **Frontend (IdP):** já está configurado para ler o metadado local `keycloak.xml`, nenhuma alteração é necessária.
* **Backend (SP):** o SATOSA se comunica com a federação, portanto é necessário estabelecer a relação de confiança com o servidor de descoberta da federação:

  ```yaml
  metadata:
    remote:
      - url: <url-servidor-descoberta-federação>
  ```

  Para uma configuração mais simples (sem depender do servidor de descoberta), coloque o metadado do IdP Shibboleth em `satosa/volumes/` e referencie-o localmente:

  ```yaml
  metadata:
    local:
      - idp-local.xml
  ```

> [!IMPORTANT]
> Os metadados da interface SP do SATOSA também precisam ser enviados ao IdP/federação, para que a relação de confiança seja estabelecida nos dois sentidos.
> Esses metadados são disponibilizados em: https://localhost/Saml2/proxy_saml2_backend.xml

**2. Reiniciar o SATOSA**

```bash
docker compose restart satosa
```
> [!TIP]
> Para a PoC funcionar **sem** a CAFe, crie usuários diretamente no Keycloak (realm `agents`). O SATOSA só é necessário para autenticação com credenciais institucionais reais.
---


## 5. Fluxo da Demonstração

> O detalhamento técnico de cada chamada HTTP e protocolo envolvido (Token Exchange, Introspection, Revocation) está em [docs/fluxo-tecnico.md](docs/fluxo-tecnico.md). Esta seção descreve o fluxo do ponto de vista de quem está usando a demonstração.

### 5.1 Login no Portal

Acesse `http://localhost:3000` e faça login. O portal mostra os agentes disponíveis, descobertos automaticamente a partir do endpoint `GET /agent-info` de cada agente — não há uma lista fixa de escopos configurada no portal.

Após o login (via Keycloak, opcionalmente federado com a CAFe através do SATOSA), você verá a tela de consentimento do agente `wgid-agent-v1`, com os escopos que ele solicita (`genomica:read`, `hpc:submit`) pré-selecionados. Você pode desmarcar escopos antes de confirmar.

### 5.2 Delegar acesso ao agente

Ao confirmar o consentimento, o portal executa o Token Exchange (RFC 8693) com o Keycloak e entrega ao agente um token derivado da sua identidade, com os escopos escolhidos. A tela de sucesso mostra o payload decodificado do token delegado — repare que o `sub` é você (a pesquisadora), não o agente.

A partir desse momento o agente está autorizado a agir em seu nome, dentro dos limites definidos.

### 5.3 Usar o agente

Com o token entregue, é possível conversar com o agente pelo **Mastra Studio** (`http://localhost:4111`) ou chamar sua API diretamente. Alguns exemplos de mensagens para testar:

```
Busque as sequências do dataset WGID-001
```

```
Submeta um job de análise usando 8 threads e 16GB de memória
```

```
Liste as sequências do dataset WGID-002 e depois submeta um job para processá-las
```

O agente decide quais ferramentas chamar a partir da mensagem, sempre usando o token delegado nas requisições à API — nenhuma credencial é digitada na conversa.

### 5.4 Ferramentas disponíveis para teste

O agente (`agent/src/mastra/tools/wgid-tool.ts`) expõe duas ferramentas que simulam operações de um serviço científico:

| Ferramenta | Escopo necessário | O que faz |
|---|---|---|
| `buscar-sequencias` | `genomica:read` | Busca sequências genômicas de um dataset (`GET /api/datasets/:id/sequences`) |
| `submeter-job` | `hpc:submit` | Submete um job de análise a um cluster HPC simulado, recebendo parâmetros livres como `threads` e `memoria` (`POST /api/jobs/submit`) |

Ambas chamam a API Server usando o token armazenado em `tokenStore`, e cada chamada é auditada em `http://localhost:3001/audit`. Se você revogar a delegação (`http://localhost:3000/delegations` → "Revogar") e tentar usar o agente novamente, as chamadas passam a ser rejeitadas pela API — é o efeito da introspection detectando o token revogado a cada requisição.

---

## 6. Protocolos e Recomendações Adotados

### RFC 8693 — OAuth 2.0 Token Exchange

**Por quê:** É o padrão para delegação de identidade em OAuth 2.0. Permite que um agente receba um token derivado das credenciais de um usuário, com escopos limitados e identidade rastreável, sem acesso às credenciais originais.

**Como está implementado:**
- `subject_token`: token da pesquisadora (obtido via Authorization Code Flow)
- `actor_token`: token do agente (obtido via Client Credentials)
- `audience: api-server`: restringe o token ao único recurso que pode usá-lo
- `scope`: limitado aos escopos selecionados no consentimento

**Limitação do Keycloak 26.x:** O `act` claim (que identificaria o agente no token, conforme seção 4.4 do RFC 8693) ainda não é emitido no Standard Token Exchange V2. O workaround adotado usa o claim `azp` (Authorized Party) para identificar o agente.


### Princípio do Menor Privilégio

Os escopos delegados ao agente são um **subconjunto** dos escopos da pesquisadora, selecionados explicitamente no consentimento. O token delegado nunca tem mais permissões do que o necessário para as tarefas do agente.


