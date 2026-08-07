if [[ -n "${_JAGENTDESK_ZSH_INTEGRATION_LOADED-}" ]]; then
  return
fi
typeset -g _JAGENTDESK_ZSH_INTEGRATION_LOADED=1

autoload -Uz add-zsh-hook

typeset -g _JAGENTDESK_ZSH_COMMAND_ACTIVE=0

function _jagentdesk_osc633() {
  printf '\e]633;%s\a' "$1"
}

function _jagentdesk_precmd() {
  local command_status=$?
  if [[ "$_JAGENTDESK_ZSH_COMMAND_ACTIVE" == "1" ]]; then
    _jagentdesk_osc633 "D;${command_status}"
    _JAGENTDESK_ZSH_COMMAND_ACTIVE=0
  fi
  printf '\e]2;%s\a' "${PWD/#$HOME/~}"
  _jagentdesk_osc633 "A"
}

function _jagentdesk_preexec() {
  _JAGENTDESK_ZSH_COMMAND_ACTIVE=1
  _jagentdesk_osc633 "B"
  _jagentdesk_osc633 "C"
  printf '\e]2;%s\a' "$1"
}

add-zsh-hook precmd _jagentdesk_precmd
add-zsh-hook preexec _jagentdesk_preexec
