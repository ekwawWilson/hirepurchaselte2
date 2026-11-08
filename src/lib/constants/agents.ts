/** After this many days of holding customers' cash without paying it in, an agent is flagged (agentLedgerService.alertLongHeldAgentCash). */
export const AGENT_CASH_HOLD_ALERT_DAYS = 3;

/**
 * A mobile money charge an agent makes on the short code to pay in the cash
 * they hold: it settles against their ledger, never as a customer's payment
 * (the customer's payment was recorded when the agent took the cash).
 */
export const AGENT_DEPOSIT_CHANNEL = 'AGENT_DEPOSIT';
