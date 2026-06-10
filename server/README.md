# Toca Ficha Dr. — Extensão Chrome para Automação do G-Hosp

**Reduza 25-35 ações por paciente para 4-6 ações.**  
Painel lateral (side panel) injetado diretamente no G-Hosp com gravação de voz, SOAP automático, CID sugerido por IA, e templates de receita.

---

## O que é o Toca Ficha Dr.?

Extensão Chrome Manifest V3 que automatiza prontuário eletrônico no sistema G-Hosp para médicos generalistas e pediatras.

### Fluxo Antes (25-35 ações/paciente)
1. Clicar Chamar → Atender
2. Deletar texto SOAP manualmente
3. Ir ao terminal → gravar → Enter → aguardar → Cmd+V
4. Buscar CID manualmente
5. Salvar prontuário
6. Abrir receita → selecionar template → ajustar dose → salvar
7. Imprimir (ícone → Cmd+P → Enter)
8. Alta → popup → sem encaminhamento → OK
9. Voltar à lista

### Fluxo Depois (4-6 ações/paciente)
1. Abrir prontuário (SOAP limpa automaticamente)
2. Clicar 🎙️ no painel lateral → falar → ⏹️ parar
3. SOAP colado automaticamente + CID sugerido
4. Confirmar CID (1 clique)
5. Selecionar template de receita (1 clique)
6. Clicar **✅ Alta e voltar** → confirmação + alta no G-Hosp e retorno à lista

**Tempo economizado**: ~60 segundos por paciente × 30 pacientes/turno = **30 minutos por turno**

---

## Instalação

### Chrome Web Store (Em breve)

A extensão será disponibilizada na Chrome Web Store. Atualmente em teste beta.

### Modo Desenvolvedor (Local)

```bash
git clone https://github.com/chrislro/tocafichadr-extension.git
cd tocafichadr-extension
npm ci
npm run build
```

1. Abra o Chrome → `chrome://extensions`
2. Ative **Modo do desenvolvedor** (canto superior direito)
3. Clique **Carregar sem compactação**
4. Selecione a pasta `tocafichadr-extension`
5. A extensão aparece na barra de ferramentas

### Backend (Mac Mini)

```bash
# No Mac Mini (produção)
ssh christianoliveira@100.97.14.32
cd ~/Dev/tocafichadr-extension/backend
./venv/bin/python run_cloud_api.py
```

Ou via launchd:
```bash
launchctl kickstart -k gui/501/com.tocafichadr.cloud-api
```

---

## Configuração

Clique no ícone da extensão na barra do Chrome (popup):

- **Nome do Médico** — usado nas notas SOAP
- **Limpar SOAP automaticamente** — limpa campos pré-preenchidos ao abrir prontuário
- **Sugerir CID por IA** — sugere código CID após transcrição
- **Instruções customizadas** — prompt adicional para personalizar a geração SOAP
- **Modelos de Receita** — edite templates personalizados (nome + corpo)

---

## Funcionalidades

### 🎙️ Gravação de Voz → SOAP
- Grava ditado médico diretamente no painel lateral
- Transcrição via Whisper (OpenAI ou Groq)
- Geração SOAP automática via GPT-4o-mini
- Preenche os 6 campos do prontuário G-Hosp

### 🔍 CID-10 Automático
- 164 códigos pediátricos com busca fuzzy
- Sugestão baseada no conteúdo do SOAP
- Preenchimento automático do campo CID com simulação de eventos jQuery UI

### 💊 Templates de Receita
- 10 posologias pediátricas padrão (Amoxicilina, Ibuprofeno, Dipirona, etc.)
- Templates editáveis pelo médico
- Contagem de uso por template
- Um clique: abre receita → preenche → salva → imprime

### 📄 Atestado Médico
- Abre tela de atestado automaticamente
- Preenche dias e observações
- Imprime "SEM CID" em um clique

### ✅ Alta e Finalizar
- Preenche data de alta automaticamente
- Seleciona "Sem encaminhamento" (ou outro conforme necessário)
- Grava alta e retorna à lista de pacientes

### 📊 Estatísticas de Uso
- Contagem diária: transcrições, receitas, finalizações
- "Minutos poupados" estimados
- Histórico de 30 dias

---

## Arquitetura

```
Chrome Extension (MV3)
├── Side Panel (painel lateral) — UI principal
├── Popup (fallback) — configurações, auth, templates
├── Content Scripts — manipulação DOM do G-Hosp
│   ├── dom-engine.js — automação de formulários
│   ├── audio-capture.js — gravação de áudio
│   ├── cid.js — banco de dados CID-10
│   └── api-client.js — cliente HTTP + proxy SW
├── Service Worker — proxy de API, auth Clerk, descoberta de URL
└── Offscreen Document — áudio/realtime quando popup fecha

Flask Backend (Mac Mini)
├── /api/transcribe — áudio → Whisper → SOAP + CID
├── /api/selectors — configuração de seletores DOM
├── /api/audit — telemetria de uso
├── /billing/subscription — Stripe billing
└── /clerk/webhook — provisionamento de usuários

Infraestrutura
├── Cloudflare Tunnel — acesso público ao Mac Mini
├── Vercel — landing page (tocafichadr.com.br)
└── Clerk — autenticação JWT
```

### STT com Groq (Opcional, Mais Rápido)

O backend suporta transcrição via **Groq** (`whisper-large-v3`) além da OpenAI. Configure `GROQ_API_KEY` no backend:

| Provedor | Modelo | Latência (5 min) | Custo/hora |
|----------|--------|------------------|------------|
| OpenAI | whisper-1 | ~50-70s | $0.36 |
| Groq | whisper-large-v3 | ~7-10s | $0.04 |

O sistema detecta automaticamente e usa Groq quando disponível.

---

## Documentação

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — Arquitetura técnica completa
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — Setup de desenvolvimento, build, testes
- **[DEPLOYMENT.md](DEPLOYMENT.md)** — Deploy na Web Store e Mac Mini
- **[NEXT_STEPS.md](NEXT_STEPS.md)** — Funcionalidades atuais, problemas conhecidos, próximos passos
- **[12FACTOR.md](12FACTOR.md)** — Adaptação 12-factor para extensões
- **[docs/](docs/)** — Documentação adicional (TESTING.md, OPERATIONS.md, etc.)

---

## Segurança & Privacidade

- **Nenhum dado de paciente armazenado**: Áudio, transcript e SOAP são processados em memória e descartados
- **Apenas metadados de uso**: Tipo de ação, timing, ID de usuário (sem conteúdo clínico)
- **Escopo mínimo de permissões**: Apenas `prbentogoncalves.g-hosp.com.br`
- **Auth via Clerk**: JWT com refresh tokens; nenhuma senha armazenada
- **CSP restritiva**: `script-src 'self'` em todas as páginas da extensão

Veja [PRIVACY_POLICY.md](PRIVACY_POLICY.md) para política completa.

---

## Requisitos

- Google Chrome 114+ (API de side panel)
- macOS / Windows / Linux (extensão roda em qualquer Chrome)
- Backend: Python 3.11+, Node.js 18+ (apenas para desenvolvimento)

---

## Licença

Proprietário — Toca Ficha Dr.  
Contato: contato@tocafichadr.com.br (em breve)

---

**Versão atual**: 3.5.0  
**Última atualização**: 2026-05-10
