# Política de Privacidade — Toca Ficha Dr.

**Última atualização:** junho de 2026 · revisão v3.8.1

---

## O que é o Toca Ficha Dr.?

Toca Ficha Dr. é uma extensão para Google Chrome que automatiza fluxos de trabalho em prontuários eletrônicos (EMR) pediátricos no sistema G-Hosp (G-UPA). Ele combina transcrição de voz, formatação de notas SOAP por inteligência artificial e automação de formulários para reduzir o tempo de registro clínico.

---

## Dados que coletamos

Para oferecer o serviço e cumprir obrigações regulatórias, o Toca Ficha Dr. coleta os seguintes dados dos usuários cadastrados:

| Dado | Finalidade | Base legal (LGPD) |
|------|------------|-------------------|
| Endereço de e-mail | Identificação e autenticação da conta | Execução de contrato |
| Nome completo | Identificação do usuário no sistema | Execução de contrato |
| Contagem de transcrições por dia | Controle de cota de plano (gratuito ou Pro) | Execução de contrato |
| Trilha de auditoria anonimizada | Segurança, detecção de erros e melhoria do serviço | Legítimo interesse |

**Trilha de auditoria**: registra tipo de ação (ex.: "transcrição", "preenchimento de SOAP"), duração em segundos e resultado (sucesso ou falha). **Nenhum dado clínico de pacientes é incluído.**

---

## Como usamos os dados (finalidade do tratamento)

Os dados coletados são tratados **exclusivamente** para as finalidades abaixo. Não usamos seus dados para nenhuma outra finalidade sem o seu consentimento.

- **E-mail e nome** — autenticar o usuário, criar e gerenciar a conta e prestar suporte.
- **Contagem de transcrições por dia** — aplicar os limites do plano (gratuito ou Pro) e o faturamento.
- **Trilha de auditoria anonimizada** — garantir a segurança do serviço, detectar erros e prevenir abuso. Não contém dados clínicos de pacientes.
- **Áudio de voz** — encaminhado aos serviços de transcrição (Groq/OpenAI), convertido em texto em memória e **imediatamente descartado** (ver "Como o áudio é processado").

### Consentimento

O tratamento de dados começa **somente após** o usuário criar uma conta e aceitar esta Política de Privacidade no primeiro acesso. O usuário é informado da coleta antes que ela ocorra e pode retirar o consentimento a qualquer momento (ver "Direitos do titular de dados" e "Exclusão de conta").

---

## Dados que NÃO coletamos

O Toca Ficha Dr. foi projetado para não armazenar qualquer informação sensível de pacientes. Especificamente, **nunca** são coletados, transmitidos ou armazenados nos servidores do Toca Ficha Dr.:

- Nomes, CPFs ou qualquer identificação de pacientes
- Gravações de áudio
- Transcrições de texto (geradas pelo Whisper)
- Notas SOAP geradas ou editadas
- Códigos CID-10 associados a pacientes específicos
- Qualquer dado de saúde (PHI) ou dado pessoal (PII) de pacientes

---

## Como o áudio é processado

Quando o médico utiliza a função de transcrição por voz:

1. O áudio gravado é enviado ao servidor do Toca Ficha Dr. para processamento.
2. O servidor encaminha o áudio à API da Groq (Whisper) ou à API da OpenAI (Whisper) para transcrição.
3. A transcrição gerada é enviada ao GPT-4o-mini (OpenAI) para formatação em nota SOAP.
4. O resultado é retornado ao médico e inserido no prontuário.
5. **O áudio e a transcrição são descartados imediatamente após o processamento — nunca são armazenados nos servidores do Toca Ficha Dr.**

Todo o processamento de áudio ocorre em memória, sem gravação em disco ou banco de dados.

---

## Armazenamento local (extensão Chrome)

A extensão utiliza `chrome.storage.sync` para armazenar:

- Configurações de preferências do usuário (ex.: "limpeza automática de SOAP")
- Modelos de receitas personalizados (texto puro, sem dados de pacientes)
- Instruções personalizadas para formatação de notas

Esses dados são sincronizados entre os dispositivos Chrome do usuário pelo Google, conforme a política do Google Chrome Sync. Nenhum dado de paciente é salvo neste armazenamento.

---

## Compartilhamento de dados com terceiros

O Toca Ficha Dr. compartilha dados com os seguintes prestadores de serviço:

### 1. Clerk (autenticação)
- **O que é compartilhado**: endereço de e-mail e dados de sessão do usuário para autenticação
- **Finalidade**: gerenciamento de contas, login seguro e controle de sessão
- **Política de privacidade**: [clerk.com/privacy](https://clerk.com/privacy)

### 2. OpenAI (transcrição e formatação de texto)
- **O que é compartilhado**: áudio de gravações de voz (para transcrição via Whisper) e texto de transcrições (para formatação via GPT-4o-mini)
- **Finalidade**: converter áudio em texto e formatar em nota SOAP
- **Garantia**: de acordo com o Contrato de Processamento de Dados da OpenAI, **os dados enviados via API não são utilizados para treinar modelos de IA**
- **Política de privacidade**: [openai.com/policies/privacy-policy](https://openai.com/policies/privacy-policy)

### 3. Groq (transcrição de áudio e codificação CID — quando disponível)
- **O que é compartilhado**: áudio de gravações de voz para transcrição via Whisper large-v3; texto de transcrições (para sugestão de código CID-10 via llama-3.3-70b-versatile)
- **Finalidade**: transcrição de voz com menor latência e sugestão de código CID-10
- **Política de privacidade**: [groq.com/privacy](https://groq.com/privacy)

**Nenhum dado é vendido, alugado ou compartilhado com terceiros para fins publicitários.**

---

## Uso limitado dos dados (Política do Chrome Web Store)

O uso das informações obtidas pela extensão Toca Ficha Dr. obedece à **Política de Uso Limitado (Limited Use)** do Chrome Web Store:

- Os dados são usados apenas para fornecer e melhorar a finalidade única da extensão — automação do registro clínico no G-Hosp.
- Os dados **não são vendidos** nem transferidos a terceiros, exceto aos sub-processadores estritamente necessários ao funcionamento do serviço, listados acima (Clerk, OpenAI e Groq).
- Os dados **não são usados** para publicidade, criação de perfis de marketing, revenda ou qualquer finalidade não relacionada.
- Nenhum ser humano lê os dados do usuário, exceto quando estritamente necessário para segurança, conformidade legal ou mediante consentimento explícito do usuário.

---

## Conformidade com a LGPD

O Toca Ficha Dr. está em conformidade com a **Lei Geral de Proteção de Dados (Lei nº 13.709/2018 — LGPD)**:

- Nenhum dado sensível de saúde de pacientes é coletado ou armazenado.
- Os dados de usuários são utilizados exclusivamente para prestação do serviço contratado.
- O usuário tem direito de acesso, correção e exclusão de seus dados a qualquer momento.
- As bases legais para tratamento dos dados são: execução de contrato (prestação do serviço) e legítimo interesse (segurança e auditoria).

---

## Armazenamento e segurança dos dados

- Os dados de conta e uso dos usuários são armazenados em servidores no **Brasil**, com criptografia em trânsito (TLS 1.2+).
- Dados de autenticação são gerenciados pela Clerk, com infraestrutura em conformidade com SOC 2.
- Senhas nunca são armazenadas pelo Toca Ficha Dr. — o acesso é gerenciado exclusivamente via Clerk.

### Retenção de dados

| Dado | Período de retenção |
|------|---------------------|
| Dados de conta (e-mail, nome) | Enquanto a conta estiver ativa + 30 dias após exclusão |
| Registros de auditoria | 90 dias |
| Dados de uso (contagem de transcrições) | 12 meses |

---

## Exclusão de conta

O usuário pode solicitar a exclusão completa de sua conta e de todos os dados associados a qualquer momento, enviando um e-mail para **contato@tocafichadr.com.br** com o assunto "Exclusão de conta". A exclusão será processada em até 15 dias úteis.

---

## Direitos do titular de dados (LGPD, art. 18)

O usuário pode exercer os seguintes direitos entrando em contato pelo e-mail abaixo:

- **Confirmação** da existência de tratamento de seus dados
- **Acesso** aos dados pessoais armazenados
- **Correção** de dados incompletos, inexatos ou desatualizados
- **Anonimização, bloqueio ou eliminação** de dados desnecessários ou tratados em desconformidade
- **Portabilidade** dos dados a outro fornecedor de serviço
- **Eliminação** dos dados tratados com consentimento
- **Informação** sobre entidades com as quais o Toca Ficha Dr. compartilhou seus dados
- **Revogação do consentimento**

---

## Contato

Para dúvidas, solicitações relacionadas à LGPD ou questões de privacidade:

**E-mail:** contato@tocafichadr.com.br  
**Site:** tocafichadr.com.br

---

## Alterações nesta política

Esta política pode ser atualizada periodicamente. Em caso de mudanças relevantes, os usuários serão notificados por e-mail com pelo menos 7 dias de antecedência. A versão mais recente estará sempre disponível em **tocafichadr.com.br/privacidade**.
