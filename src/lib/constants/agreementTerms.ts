/**
 * The standard terms printed on a customer's agreement, per contract type.
 * Plain-language defaults: have them reviewed against your own terms of
 * business before relying on them, and edit them here — the agreement page
 * prints whatever this file says.
 */
export const AGREEMENT_TITLES: Record<string, string> = {
  DEPOSIT_INSTALMENT: 'Hire Purchase Agreement',
  SAVE_TO_OWN: 'Save to Own Agreement',
  DEVICE_LOAN: 'Loan Agreement',
};

export const AGREEMENT_TERMS: Record<string, string[]> = {
  DEPOSIT_INSTALMENT: [
    'The Customer takes the goods described above on hire purchase and agrees to pay the total price by the deposit and instalments set out in this agreement.',
    'The goods remain the property of the Company until the total price, and any late-payment charge due under this agreement, has been paid in full. Ownership passes to the Customer on the final payment.',
    'The Customer will keep the goods in their own possession and in good condition, and will not sell, pledge, lend or otherwise part with them before ownership has passed.',
    'Each instalment is due on the date shown in the schedule. An instalment not paid by its due date is in arrears.',
    'If the Customer remains in arrears after the grace period, a late-payment charge may be added as stated above, and the Company may contact the Customer and the Guarantor to recover what is owed.',
    'If the Customer fails to pay and does not put matters right after being given notice, the Company may end this agreement and recover the goods, as far as the law allows.',
    'The Customer may pay off the outstanding balance early at any time.',
    'Where the Customer has authorised direct debit, the Company may collect each instalment from the mobile money wallet named by the Customer when it falls due. The Customer may withdraw that authority at any time.',
    'The Customer must tell the Company promptly if their phone number, home address or place of work changes.',
    'The Guarantor agrees to pay any amount due under this agreement that the Customer fails to pay.',
  ],
  SAVE_TO_OWN: [
    'The Customer may pay any amount into this savings plan at any time. There is no fixed instalment and no due date.',
    'Money paid in remains the Customer\'s. It is held by the Company towards the purchase of goods from the Company.',
    'The Customer may withdraw all or part of what they have saved, or cancel the plan, by asking at the Company\'s office. Money withdrawn is paid back to the Customer.',
    'Goods are released to the Customer only once their price has been paid in full.',
    'The Customer must tell the Company promptly if their phone number or address changes.',
  ],
  DEVICE_LOAN: [
    'The Company lends the Customer the loan amount stated above, which the Customer agrees to repay in full.',
    'Interest is charged at the daily rate stated above on the loan amount for each working day the loan remains unpaid after the grace period.',
    'The Customer may pay the interest owed to date, or repay the full loan amount, at any time. The loan is settled only when the loan amount and all interest owed have been paid.',
    'If interest remains unpaid, the Company may contact the Customer and the Guarantor to recover what is owed, and may take such further steps as the law allows.',
    'The Customer must tell the Company promptly if their phone number, home address or place of work changes.',
    'The Guarantor agrees to pay any amount due under this agreement that the Customer fails to pay.',
  ],
};
