/**
 * Scenario name validation and creation helpers shared by the service worker
 * and the UIs.
 */
import { LIMITS } from './constants.js';

/**
 * Trim and validate a user supplied scenario name.
 * @param {unknown} name
 * @returns {string}
 */
export function normalizeScenarioName(name) {
  const value = String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!value) throw new Error('Give the scenario a name.');
  if (value.length > LIMITS.MAX_SCENARIO_NAME) {
    throw new Error(`Scenario names are limited to ${LIMITS.MAX_SCENARIO_NAME} characters.`);
  }
  return value;
}

/** @returns {string} */
export function newScenarioId() {
  return crypto.randomUUID();
}

/**
 * @param {unknown} name
 * @param {number} [now]
 */
export function newScenario(name, now = Date.now()) {
  const value = normalizeScenarioName(name);
  return { id: newScenarioId(), name: value, createdAt: now, updatedAt: now };
}
