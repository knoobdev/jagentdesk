// JAgentDesk vendor patch (see ../../README.md). Replaces upstream archify's
// brand-marks.mjs, which embedded third-party logo path data (several with
// their own licenses, see THIRD_PARTY_NOTICES.md) and could capture site icons
// over HTTP(S). This build ships NO brand marks and makes NO network requests:
// any authored `brand` field is rejected with a diagnostic so the agent removes
// it, and every render helper behaves as if no node had a mark.
import { throwDiagnosticError } from './diagnostics.mjs';

const COLLECTIONS = Object.freeze({
  architecture: 'components',
  workflow: 'nodes',
  sequence: 'participants',
  dataflow: 'nodes',
  lifecycle: 'states',
});

export function findBrandMark() {
  return null;
}

export function listBrandMarks() {
  return [];
}

export async function prepareDiagramBrandMarks(diagramType, diagram) {
  const collection = COLLECTIONS[diagramType];
  const nodes = collection && Array.isArray(diagram?.[collection]) ? diagram[collection] : [];
  const problems = [];
  nodes.forEach((node, index) => {
    if (node && node.brand !== undefined) {
      problems.push(`/${collection}/${index}/brand is not supported: brand marks are not available in this build; remove the brand field`);
    }
  });
  if (!problems.length) return;
  throwDiagnosticError(`Brand mark validation failed:\n- ${problems.join('\n- ')}`, problems.map((message) => ({
    code: 'brand/unsupported',
    severity: 'error',
    message,
    subject: { diagramType, collection },
    evidence: {},
    supportedFixes: ['remove the brand field; use type/icon to convey the component kind'],
  })));
}

export function brandMarkFor() {
  return null;
}

export function brandMetadataFor() {
  return {};
}

export function brandLabelFitWidth(_node, width) {
  return width;
}

export function brandTopRailProblem() {
  return null;
}

export function renderBrandMark() {
  return '';
}
