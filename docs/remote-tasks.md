# Remote tasks: run work on another machine from chat

Remote tasks let an agent on your daemon machine (for example a Mac) run commands on another machine
(for example a Windows PC through WSL2). The agent sends a copy of the current workspace, runs the
command there and shows the result in the chat. Spec: remote execution (spec 33, ADR-0044).

## How it works

- The other machine is an ordinary **SSH server** in **Servers**, with **Remote tasks** turned on.
- With **Route → JAgentDesk Tailscale**, SSH goes through the daemon's embedded Tailscale node. The
  daemon machine does not need the Tailscale app. The target must be in the same tailnet.
- **What gets sent.** By default the agent's current folder. In a git repository: tracked files and
  new, non-ignored files, including uncommitted changes. In a folder that is not a git repository: every
  file except dependency, cache and VCS folders (`node_modules`, `.venv`, `__pycache__`, `.next`, `.git`
  and similar); any git repository found inside follows its own `.gitignore`. `.env`, private keys and
  similar files are never sent. Limits: 1 GiB per run, 100 MiB per file.
- **Choosing what to send.** The agent can pass `source` to send only some folders inside the current
  folder (for example `source: "mosa-be"` or `["mosa-be", "mosa-ui"]`), or `sendCode: false` to run a
  command without sending any code. Folders outside the current folder cannot be sent.
- **Where it runs on the target.** The default copy lives in `<work folder>/<workspace key>/src`;
  folders chosen with `source` live in `.../sources/<name>`. Later runs only send changes; anything else
  in those folders (for example `node_modules` installed on the target) stays.
- **`remote_run` vs `ssh_run`.** `remote_run` is for project work (build, test, scripts, long jobs) on a
  copy of the code. `ssh_run` runs a quick command on the server itself (uptime, disk, services) in the
  home folder without sending code. Both show their result as a card in the chat.
- Jobs run detached from the SSH session and keep running if the connection drops. Each run and each
  Stop asks for your permission in the chat.

## Prepare a Windows PC (WSL2)

Run in **PowerShell (Run as Administrator)**:

```powershell
wsl --update
wsl -l -v          # VERSION must be 2; note the distro NAME
```

In the **Ubuntu (WSL)** terminal:

```bash
# 1. systemd (skip if `systemctl is-system-running` already answers running/degraded)
printf '[boot]\nsystemd=true\n' | sudo tee -a /etc/wsl.conf   # then `wsl --shutdown` in PowerShell and reopen Ubuntu

# 2. Tailscale inside WSL, signed in to the same tailnet as the daemon
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=pc-wsl
tailscale ip -4                       # the address to use in JAgentDesk

# 3. SSH server
sudo apt-get update && sudo apt-get install -y openssh-server
sudo systemctl enable --now ssh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub   # compare with the fingerprint JAgentDesk shows
```

WSL stops when no window is open. To keep it running after you sign in to Windows, in PowerShell
(replace `<distro>`):

```powershell
$a = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d <distro> --exec sleep infinity"
$t = New-ScheduledTaskTrigger -AtLogOn
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "WSL keepalive" -Action $a -Trigger $t -Settings $s
```

## Add the PC in JAgentDesk

1. **Servers → Keychain**: generate an Ed25519 key (or import one) and copy its public key.
2. On the PC, in Ubuntu, add that public key for your user:
   ```bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   echo '<public key>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys
   chmod go-w ~
   ```
3. **Servers → Add server**: address = the PC's Tailscale IP or name, user = your Ubuntu user,
   authentication = the key. Under **Remote tasks**: **Route → JAgentDesk Tailscale**, turn on
   **Use for remote tasks**, keep the default work folder or set your own, **Save**.
4. Connect once and accept the host key only if it matches `ssh-keygen -lf` from step 3 above.
5. Edit the server again and press **Check**: every line should be green.

Then ask an agent in any project, for example: "Run the test suite on my PC." From a folder that holds
many repositories, name the one you mean: "Run the tests of mosa-be on my PC."

## Limits

- Targets need a POSIX shell, `tar` and `setsid` (Linux, WSL2). macOS targets lack `setsid`; plain
  Windows without WSL is not supported.
- Snapshot limit: 1 GiB in total, 100 MiB per file. Files are not copied back.
- A Linux/WSL result does not prove macOS or iOS behaviour.
- If Windows also runs Tailscale and SSH stalls on large transfers, see Tailscale's
  [WSL 2 notes](https://tailscale.com/kb/1295/install-windows-wsl2) about MTU.
