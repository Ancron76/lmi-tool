/**
 * Maps a loan program name to the corresponding current market rate.
 * Used by refi detection to compare a customer's locked rate against
 * the current rate for their exact program.
 *
 * @param {string} loanProgram - One of the supported program names
 * @param {object} rates - Rate object from useMortgageRates hook
 * @returns {number|null} The current rate for this program, or null
 */
export function getRateForProgram(loanProgram, rates) {
  if (!rates) return null;

  const map = {
    "30-Year Fixed":            rates?.purchase?.conventional30,
    "15-Year Fixed":            rates?.purchase?.conventional15,
    "30-Year Fixed FHA":        rates?.purchase?.fha30,
    "30-Year Fixed VA":         rates?.purchase?.va30
                                  || rates?.purchase?.conventional30,
    "30-Year Fixed Jumbo":      rates?.purchase?.jumbo30,
    "15-Year Fixed Jumbo":      rates?.purchase?.conventional15Jumbo
                                  || rates?.purchase?.jumbo30,
    "5-Year SOFR ARM":          rates?.purchase?.arm5,
    "7-Year SOFR ARM":          rates?.purchase?.arm7,
    "10-Year SOFR ARM":         rates?.purchase?.arm10,
    "5-Year SOFR ARM Jumbo":    rates?.purchase?.arm5Jumbo
                                  || rates?.purchase?.arm5,
    "7-Year SOFR ARM Jumbo":    rates?.purchase?.arm7Jumbo
                                  || rates?.purchase?.arm7,
    "10-Year SOFR ARM Jumbo":   rates?.purchase?.arm10Jumbo
                                  || rates?.purchase?.arm10,
    "HELOC Variable":           rates?.equity?.heloc,
    "Other":                    rates?.purchase?.conventional30,
  };

  return map[loanProgram] ?? rates?.purchase?.conventional30 ?? null;
}

/**
 * Maps a loan program name to its category.
 */
export function programToCategory(program) {
  const map = {
    "30-Year Fixed": "Conventional",
    "15-Year Fixed": "Conventional",
    "30-Year Fixed FHA": "FHA",
    "30-Year Fixed VA": "VA",
    "30-Year Fixed Jumbo": "Jumbo",
    "15-Year Fixed Jumbo": "Jumbo",
    "5-Year SOFR ARM": "ARM - Conventional",
    "7-Year SOFR ARM": "ARM - Conventional",
    "10-Year SOFR ARM": "ARM - Conventional",
    "5-Year SOFR ARM Jumbo": "ARM - Jumbo",
    "7-Year SOFR ARM Jumbo": "ARM - Jumbo",
    "10-Year SOFR ARM Jumbo": "ARM - Jumbo",
    "HELOC Variable": "HELOC",
    "Other": "Other",
  };
  return map[program] || "";
}

/**
 * Maps a legacy loanType value to the default program name.
 * Used when auto-creating past customers from funded deals.
 */
export function loanTypeToProgram(loanType) {
  const map = {
    "Conventional": "30-Year Fixed",
    "FHA": "30-Year Fixed FHA",
    "VA": "30-Year Fixed VA",
    "Jumbo": "30-Year Fixed Jumbo",
    "USDA": "30-Year Fixed",
  };
  return map[loanType] || "30-Year Fixed";
}
