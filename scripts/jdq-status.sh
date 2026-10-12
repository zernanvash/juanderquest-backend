#!/usr/bin/env bash
set -e

# JuanDerQuest Real-Time Remote Monitoring Dashboard

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GOLD='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

clear 2>/dev/null || true

echo -e "${GOLD}${BOLD}==============================================================${NC}"
echo -e "${GREEN}${BOLD}   🧭 JuanDerQuest — Live Remote System & Website Monitor${NC}"
echo -e "${CYAN}   Host: $(hostname) | Date: $(date '+%Y-%m-%d %H:%M:%S %Z')${NC}"
echo -e "${GOLD}${BOLD}==============================================================${NC}"
echo ""

# 1. Endpoint Health Probes
echo -e "${BOLD}🌐 PUBLIC WEBSITES & API HEALTH:${NC}"

# A WSL restart (Windows reboot, `wsl --shutdown`, or a WSL package update)
# kills the Cloudflare Tunnel origins for the ~1-2 minutes the stack needs to
# boot. When a probe fails shortly after WSL started, wait out the boot window
# instead of reporting the endpoints as down.
BOOT_AGE_LIMIT=600      # seconds since WSL boot treated as "still booting"
BOOT_GRACE_SECONDS=180  # max wait for a booting stack before reporting
boot_age=$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 99999)

probe_endpoint() {
  curl -s -k -o /dev/null -w "%{http_code} %{time_total}" --connect-timeout 5 --max-time 10 "$1" 2>/dev/null || echo "ERR 0"
}

endpoint_names=("Traveler Web App" "Express REST API" "LGU Admin Dashboard")
endpoint_urls=("https://juanderquest.app" "https://api.juanderquest.app/api/v1/health" "https://admin.juanderquest.app")
endpoint_codes=()
endpoint_times=()
endpoint_recovered=()

pending=0
for i in "${!endpoint_urls[@]}"; do
  result=$(probe_endpoint "${endpoint_urls[$i]}")
  endpoint_codes[$i]=$(echo "$result" | awk '{print $1}')
  endpoint_times[$i]=$(echo "$result" | awk '{print $2}')
  endpoint_recovered[$i]=0
  if [ "${endpoint_codes[$i]}" != "200" ]; then
    pending=1
  fi
done

if [ "$pending" -eq 1 ] && [ "$boot_age" -lt "$BOOT_AGE_LIMIT" ]; then
  echo -e "  ${YELLOW}⏳ WSL started ${boot_age}s ago and the stack is not fully up yet;${NC}"
  echo -e "  ${YELLOW}   waiting up to ${BOOT_GRACE_SECONDS}s for the boot to finish…${NC}"
  echo ""
  wait_start=$SECONDS
  while [ $((SECONDS - wait_start)) -lt "$BOOT_GRACE_SECONDS" ]; do
    sleep 5
    pending=0
    for i in "${!endpoint_urls[@]}"; do
      if [ "${endpoint_codes[$i]}" = "200" ]; then
        continue
      fi
      result=$(probe_endpoint "${endpoint_urls[$i]}")
      endpoint_codes[$i]=$(echo "$result" | awk '{print $1}')
      endpoint_times[$i]=$(echo "$result" | awk '{print $2}')
      if [ "${endpoint_codes[$i]}" = "200" ]; then
        endpoint_recovered[$i]=$((SECONDS - wait_start))
      else
        pending=1
      fi
    done
    if [ "$pending" -eq 0 ]; then
      break
    fi
  done
fi

for i in "${!endpoint_urls[@]}"; do
  name="${endpoint_names[$i]}"
  url="${endpoint_urls[$i]}"
  code="${endpoint_codes[$i]}"
  time="${endpoint_times[$i]}"

  if [ "$code" = "200" ]; then
    echo -e "  [ ${GREEN}● ONLINE${NC} ] ${BOLD}$name${NC}"
    echo -e "             URL: ${CYAN}$url${NC}"
    echo -e "             Status: ${GREEN}HTTP $code OK${NC} | Response Time: ${YELLOW}${time}s${NC}"
    if [ "${endpoint_recovered[$i]}" -gt 0 ]; then
      echo -e "             ${YELLOW}Note: recovered ${endpoint_recovered[$i]}s into the post-boot wait window.${NC}"
    fi
  else
    echo -e "  [ ${RED}✖ DOWN/ERR${NC} ] ${BOLD}$name${NC}"
    echo -e "             URL: ${CYAN}$url${NC}"
    echo -e "             Status: ${RED}HTTP $code${NC}"
  fi
  echo ""
done

if [ "$pending" -eq 1 ]; then
  echo -e "  ${YELLOW}Hint:${NC} check ${BOLD}pm2 list${NC} / ${BOLD}pm2 logs <service>${NC} and ${BOLD}docker ps${NC} before restarting the stack."
  echo ""
fi

# 2. PM2 Managed Services
echo -e "${BOLD}🚀 PM2 PROCESS MANAGER STATUS:${NC}"
if command -v pm2 >/dev/null 2>&1; then
  pm2 list
else
  echo -e "  ${RED}pm2 command not found in PATH${NC}"
fi
echo ""

# 3. Docker Containers
echo -e "${BOLD}🐳 DATABASE CONTAINERS & ROUTING DAEMON:${NC}"
for cname in jdq-alpha-postgres juanderquest_valhalla_local; do
  if docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | grep -q "$cname"; then
    info=$(docker ps --filter "name=$cname" --format '{{.Status}} (Port {{.Ports}})')
    echo -e "  [ ${GREEN}● RUNNING${NC} ] ${BOLD}$cname${NC}: $info"
  else
    echo -e "  [ ${YELLOW}○ STOPPED${NC} ] ${BOLD}$cname${NC}"
  fi
done
echo ""

# 4. System Resources
echo -e "${BOLD}📊 SYSTEM RESOURCES & TELEMETRY:${NC}"
echo -e "  Uptime:   ${CYAN}$(uptime -p 2>/dev/null || uptime)${NC}"
echo -e "  Load Avg: ${CYAN}$(cat /proc/loadavg | awk '{print $1, $2, $3}')${NC}"
mem_info=$(free -h | awk '/^Mem:/ {print "Used: " $3 " / " $2 " (Free: " $4 ")"}')
echo -e "  Memory:   ${CYAN}$mem_info${NC}"
disk_info=$(df -h / | awk 'NR==2 {print "Used: " $3 " / " $2 " (" $5 " used)"}')
echo -e "  Disk (/): ${CYAN}$disk_info${NC}"
echo ""

# 5. Quick Commands Reminder
echo -e "${GOLD}${BOLD}⚡ QUICK MANAGEMENT SHORTCUTS:${NC}"
echo -e "  - Run ${BOLD}jdq-status${NC} anytime to re-check status"
echo -e "  - Run ${BOLD}watch -n 5 jdq-status${NC} for live auto-refreshing monitor"
echo -e "  - Run ${BOLD}pm2 logs${NC} or ${BOLD}pm2 logs <service>${NC} to stream logs"
echo -e "  - Run ${BOLD}pm2 restart all${NC} to reload backend, web, and dashboard"
echo -e "  - Run ${BOLD}docker logs jdq-alpha-postgres --tail 10${NC} for DB logs"
echo -e "${GOLD}==============================================================${NC}"
