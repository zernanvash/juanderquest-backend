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

check_endpoint() {
  local name="$1"
  local url="$2"
  local result
  result=$(curl -s -k -o /dev/null -w "%{http_code} %{time_total}" --connect-timeout 4 --max-time 6 "$url" 2>/dev/null || echo "ERR 0")
  local code=$(echo "$result" | awk '{print $1}')
  local time=$(echo "$result" | awk '{print $2}')

  if [ "$code" = "200" ]; then
    echo -e "  [ ${GREEN}● ONLINE${NC} ] ${BOLD}$name${NC}"
    echo -e "             URL: ${CYAN}$url${NC}"
    echo -e "             Status: ${GREEN}HTTP $code OK${NC} | Response Time: ${YELLOW}${time}s${NC}"
  else
    echo -e "  [ ${RED}✖ DOWN/ERR${NC} ] ${BOLD}$name${NC}"
    echo -e "             URL: ${CYAN}$url${NC}"
    echo -e "             Status: ${RED}HTTP $code${NC}"
  fi
  echo ""
}

check_endpoint "Traveler Web App" "https://juanderquest.app"
check_endpoint "Express REST API" "https://api.juanderquest.app/api/v1/spots/spot-hundred-islands"
check_endpoint "LGU Admin Dashboard" "https://admin.juanderquest.app"

# 2. Local Daemons & Containers
echo -e "${BOLD}🐳 BACKEND SERVICES & CONTAINERS:${NC}"
if docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null | grep -q 'jdq-alpha-postgres'; then
  pg_info=$(docker ps --filter "name=jdq-alpha-postgres" --format '{{.Status}} (Port {{.Ports}})')
  echo -e "  [ ${GREEN}● RUNNING${NC} ] ${BOLD}PostgreSQL Alpha DB Container${NC}"
  echo -e "             Details: $pg_info"
else
  echo -e "  [ ${RED}✖ STOPPED${NC} ] ${BOLD}PostgreSQL Alpha DB Container${NC}"
fi

if pgrep -f 'node.*dist/server.js' >/dev/null 2>&1; then
  api_pid=$(pgrep -f 'node.*dist/server.js' | head -n1)
  echo -e "  [ ${GREEN}● ACTIVE${NC}  ] ${BOLD}Backend REST API Daemon${NC} (PID: $api_pid)"
else
  echo -e "  [ ${RED}✖ INACTIVE${NC} ] ${BOLD}Backend REST API Daemon${NC}"
fi
echo ""

# 3. System Resources
echo -e "${BOLD}📊 SYSTEM RESOURCES & TELEMETRY:${NC}"
echo -e "  Uptime:   ${CYAN}$(uptime -p 2>/dev/null || uptime)${NC}"
echo -e "  Load Avg: ${CYAN}$(cat /proc/loadavg | awk '{print $1, $2, $3}')${NC}"
mem_info=$(free -h | awk '/^Mem:/ {print "Used: " $3 " / " $2 " (Free: " $4 ")"}')
echo -e "  Memory:   ${CYAN}$mem_info${NC}"
disk_info=$(df -h / | awk 'NR==2 {print "Used: " $3 " / " $2 " (" $5 " used)"}')
echo -e "  Disk (/): ${CYAN}$disk_info${NC}"
echo ""

# 4. Quick Commands Reminder
echo -e "${GOLD}${BOLD}⚡ QUICK MANAGEMENT SHORTCUTS:${NC}"
echo -e "  - Run ${BOLD}jdq-status${NC} anytime to re-check status"
echo -e "  - Run ${BOLD}watch -n 5 jdq-status${NC} for auto-refreshing 5s monitor"
echo -e "  - Run ${BOLD}docker logs jdq-alpha-postgres --tail 10${NC} for DB logs"
echo -e "  - Run ${BOLD}cd /mnt/c/Users/HP/Desktop/Code/JuanderQuest${NC} to access project files"
echo -e "${GOLD}==============================================================${NC}"
