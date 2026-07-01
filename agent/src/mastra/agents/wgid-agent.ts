import { Agent } from '@mastra/core/agent';
import { Memory } from '@mastra/memory';
import { buscarSequencias, submeterJob } from '../tools/wgid-tool';

export const wgidAgent = new Agent({
  id: 'wgid-agent',
  name: 'WGID Agent',
  instructions: `Você é um assistente de análise genômica agindo em nome de uma pesquisadora
    da federação CAFe. Use as ferramentas disponíveis para buscar sequências
    e submeter jobs de análise. Sempre confirme as ações antes de executá-las.`,
  model: 'google/gemini-2.5-flash',
  tools: { buscarSequencias, submeterJob },
//   scorers: {
//     toolCallAppropriateness: {
//       scorer: scorers.toolCallAppropriatenessScorer,
//       sampling: {
//         type: 'ratio',
//         rate: 1,
//       },
//     },
//     completeness: {
//       scorer: scorers.completenessScorer,
//       sampling: {
//         type: 'ratio',
//         rate: 1,
//       },
//     },
//     translation: {
//       scorer: scorers.translationScorer,
//       sampling: {
//         type: 'ratio',
//         rate: 1,
//       },
//     },
//   },
  memory: new Memory(),
});
