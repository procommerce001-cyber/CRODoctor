'use strict';

// ---------------------------------------------------------------------------
// cro.service.js — legacy compatibility shim
//
// The CRO engine has been refactored into src/services/cro/*.
// This file re-exports the public API so any external code that imported
// from 'cro.service' continues to work without modification.
//
// Do not add logic here. Use the modules in src/services/cro/ directly.
// ---------------------------------------------------------------------------

const { analyzeProduct } = require('./cro/analyzeProduct');
const { analyzeStore }   = require('./cro/analyzeStore');

// buildActionPlan is the old name for analyzeStore — kept for compat
function buildActionPlan(products, shop = '') {
  return analyzeStore(shop, products);
}

module.exports = { analyzeProduct, buildActionPlan };
