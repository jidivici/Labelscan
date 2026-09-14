#!/usr/bin/env bash
# Read-only VPS checks. Does not print environments, keys, tokens or application data.
set -u

section() { printf '\n### %s\n' "$1"; }
section 'UTC / clock synchronization'
date -u
timedatectl show -p NTPSynchronized 2>/dev/null || true
section 'Listening sockets and logged-in SSH users'
ss -lntup
who
section 'Effective SSH policy'
sshd -T 2>/dev/null | grep -E '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin|authenticationmethods|maxauthtries|allowtcpforwarding|allowagentforwarding|x11forwarding|loglevel) '
section 'Host firewall (IPv4 and IPv6)'
ufw status verbose 2>/dev/null || true
section 'Bans and failed SSH authentication'
fail2ban-client status sshd 2>/dev/null || true
journalctl -u ssh -u sshd --since '1 hour ago' --no-pager -n 100 2>/dev/null || true
section 'Containers: exposed ports, image and health'
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
while read -r id; do
  [ -n "$id" ] || continue
  docker inspect --format '{{.Name}} user={{.Config.User}} readonly={{.HostConfig.ReadonlyRootfs}} privileged={{.HostConfig.Privileged}} logging={{json .HostConfig.LogConfig}} security={{json .HostConfig.SecurityOpt}} caps={{json .HostConfig.CapDrop}}' "$id"
done < <(docker ps -q --filter label=com.docker.compose.project=labelscan-single-vps)
section 'Disk capacity / backup metadata'
df -h / /opt/labelscan
du -sh /opt/labelscan/backups 2>/dev/null || true
find /opt/labelscan/backups -maxdepth 1 -type f -printf '%TY-%Tm-%Td %TH:%TM %s %f\n' 2>/dev/null | sort | tail -10
section 'System security service state'
systemctl is-active fail2ban unattended-upgrades auditd 2>/dev/null || true
section 'Secret-file permissions (names and modes only)'
find /opt/labelscan/secrets -maxdepth 1 -type f -printf '%m %u:%g %f\n' 2>/dev/null || true
