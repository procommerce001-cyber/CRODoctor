'use strict';

const EXECUTION_MAP = {
  CONTENT_CHANGE:  { executionType: 'shopify_liquid', canAutoApply: true  },
  THEME_PATCH:     { executionType: 'frontend_js',    canAutoApply: false },
  APP_CONFIG:      { executionType: 'manual',         canAutoApply: false },
  MERCHANT_ACTION: { executionType: 'manual',         canAutoApply: false },
};

const RISK_MAP = {
  CONTENT_CHANGE:  'low',
  THEME_PATCH:     'medium',
  APP_CONFIG:      'medium',
  MERCHANT_ACTION: 'low',
};

const REASON_MAP = {
  CONTENT_CHANGE:  'Low confidence — issue may not be real, auto-apply unsafe.',
  THEME_PATCH:     'Theme modification requires manual developer review.',
  APP_CONFIG:      'Requires third-party app installation and configuration.',
  MERCHANT_ACTION: 'Requires manual action in Shopify Admin.',
};

function classifyExecution(rule) {
  if (!rule || typeof rule !== 'object') {
    return {
      canAutoApply:  false,
      reason:        'Invalid rule input.',
      executionType: 'manual',
      riskLevel:     'high',
    };
  }

  const implType  = typeof rule.implementationType === 'string' ? rule.implementationType : '';
  const confidence = typeof rule.confidence === 'string' ? rule.confidence : '';

  const entry = EXECUTION_MAP[implType] ?? { executionType: 'manual', canAutoApply: false };
  const canAutoApply = entry.canAutoApply && confidence !== 'low';

  const reason = canAutoApply
    ? 'Content change with sufficient confidence — safe to auto-apply.'
    : (REASON_MAP[implType] ?? 'Unknown implementation type — defaulting to manual.');

  return {
    canAutoApply,
    reason,
    executionType: entry.executionType,
    riskLevel:     RISK_MAP[implType] ?? 'medium',
  };
}

module.exports = { classifyExecution };
