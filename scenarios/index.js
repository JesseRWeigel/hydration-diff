import randomDuringRender from './random-during-render.js';
import timeDuringRender from './time-during-render.js';
import envBranch from './env-branch.js';
import localeTimezone from './locale-timezone.js';
import clientStorage from './client-storage.js';
import nestingDivInP from './nesting-div-in-p.js';
import nestingPInP from './nesting-p-in-p.js';
import extensionMutation from './extension-mutation.js';
import controlTextSeparators from './control-text-separators.js';
import controlAttributeShapes from './control-attribute-shapes.js';

export const scenarios = [
  randomDuringRender,
  timeDuringRender,
  envBranch,
  localeTimezone,
  clientStorage,
  nestingDivInP,
  nestingPInP,
  extensionMutation,
  controlTextSeparators,
  controlAttributeShapes,
];

export function getScenario(id) {
  const found = scenarios.find((s) => s.id === id);
  if (!found) throw new Error(`unknown scenario: ${id}`);
  return found;
}

export function variantsOf(scenario) {
  return Object.keys(scenario.variants);
}
