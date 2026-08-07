typeset -g JAGENTDESK_SHELL_INTEGRATION_DIR="${${(%):-%N}:A:h}"

if [[ -n "${JAGENTDESK_ZSH_ZDOTDIR-}" ]]; then
  export ZDOTDIR="${JAGENTDESK_ZSH_ZDOTDIR}"
else
  unset ZDOTDIR
fi

if [[ -n "${ZDOTDIR-}" ]]; then
  if [[ -f "${ZDOTDIR}/.zshenv" ]]; then
    source "${ZDOTDIR}/.zshenv"
  fi
elif [[ -f "${HOME}/.zshenv" ]]; then
  source "${HOME}/.zshenv"
fi

source "${JAGENTDESK_SHELL_INTEGRATION_DIR}/jagentdesk-integration.zsh"
