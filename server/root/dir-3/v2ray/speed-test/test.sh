#!/bin/bash

# ============================================
# CONFIGURATION
# ============================================
# IP list file (one IP per line)
IP_FILE="ips.txt"

# Ping settings
PING_COUNT=5
TIMEOUT=2

# Color thresholds (in milliseconds)
GREEN_THRESHOLD=100    # < 100ms = Green (Good)
YELLOW_THRESHOLD=200   # 100-200ms = Yellow (OK)
# > 200ms = Red (Bad)

# ============================================
# SCRIPT STARTS HERE - No need to edit below
# ============================================

# Color codes for better output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check if ips.txt exists
if [ ! -f "$IP_FILE" ]; then
    echo -e "${RED}Error: $IP_FILE not found in current directory${NC}"
    echo -e "${YELLOW}Please create $IP_FILE with one IP address per line${NC}"
    echo ""
    echo -e "Example $IP_FILE:"
    echo "8.8.8.8"
    echo "1.1.1.1"
    echo "192.168.1.1"
    exit 1
fi

# Read IPs from file (ignore empty lines and comments)
mapfile -t IPS < <(grep -v '^[[:space:]]*$' "$IP_FILE" | grep -v '^[[:space:]]*#')

# Check if any IPs were found
if [ ${#IPS[@]} -eq 0 ]; then
    echo -e "${RED}Error: No IP addresses found in $IP_FILE${NC}"
    echo -e "${YELLOW}Please add at least one IP address to $IP_FILE${NC}"
    exit 1
fi

# Function to compare floating point numbers without bc
compare_float() {
    awk -v a="$1" -v b="$2" 'BEGIN {print (a < b) ? 1 : 0}'
}

# Function to ping an IP and extract average time
ping_ip() {
    local ip=$1
    local avg_time=999999
    local packet_loss=100
    local min_time=999999
    local max_time=0
    local mdev=0
    
    # Run ping and capture output
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        ping_output=$(ping -c $PING_COUNT -W $TIMEOUT $ip 2>/dev/null)
    else
        # Linux
        ping_output=$(ping -c $PING_COUNT -W $TIMEOUT $ip 2>/dev/null)
    fi
    
    # Check if ping was successful
    if [ $? -eq 0 ]; then
        # Extract packet loss
        packet_loss=$(echo "$ping_output" | grep -o "[0-9]*% packet loss" | grep -o "[0-9]*")
        if [ -z "$packet_loss" ]; then
            packet_loss=0
        fi
        
        # Extract average time (different format on different OS)
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS format
            avg_time=$(echo "$ping_output" | grep "avg" | awk -F'/' '{print $5}')
            min_time=$(echo "$ping_output" | grep "avg" | awk -F'/' '{print $4}')
            max_time=$(echo "$ping_output" | grep "avg" | awk -F'/' '{print $6}')
            mdev=$(echo "$ping_output" | grep "stddev" | awk -F'/' '{print $4}' | sed 's/ //g')
        else
            # Linux format - try different patterns
            # Pattern 1: Standard Linux ping output
            avg_time=$(echo "$ping_output" | grep -E "avg|rtt" | grep -oE "avg[=/][0-9.]+" | grep -oE "[0-9.]+" | head -1)
            
            # If not found, try pattern 2
            if [ -z "$avg_time" ]; then
                avg_time=$(echo "$ping_output" | grep -E "time=.*ms" | awk -F'time=' '{print $2}' | awk '{print $1}' | awk '{sum+=$1; count++} END {if (count>0) printf "%.1f", sum/count}')
            fi
            
            # Extract min, max, mdev
            rtt_line=$(echo "$ping_output" | grep -E "rtt|round-trip")
            if [ -n "$rtt_line" ]; then
                min_time=$(echo "$rtt_line" | grep -oE "min/avg/max/mdev = [0-9.]+/[0-9.]+/[0-9.]+/[0-9.]+" | awk -F'=' '{print $2}' | awk -F'/' '{print $1}')
                max_time=$(echo "$rtt_line" | grep -oE "min/avg/max/mdev = [0-9.]+/[0-9.]+/[0-9.]+/[0-9.]+" | awk -F'=' '{print $2}' | awk -F'/' '{print $3}')
                mdev=$(echo "$rtt_line" | grep -oE "min/avg/max/mdev = [0-9.]+/[0-9.]+/[0-9.]+/[0-9.]+" | awk -F'=' '{print $2}' | awk -F'/' '{print $4}')
            fi
        fi
        
        # If no avg time found, set to 999999
        if [ -z "$avg_time" ] || [ "$avg_time" = "0" ] || [ "$avg_time" = "0.0" ]; then
            avg_time=999999
        fi
    else
        avg_time=999999
        packet_loss=100
        min_time="-"
        max_time="-"
        mdev="-"
    fi
    
    echo "$ip|$avg_time|$packet_loss|$min_time|$max_time|$mdev"
}

# Simple progress function using dots and percentage
show_progress() {
    local current=$1
    local total=$2
    local ip=$3
    local percent=$((current * 100 / total))
    
    # Calculate how many dots to show
    local dots=$((percent / 2))
    local spaces=$((50 - dots))
    
    # Build the progress bar
    local bar=""
    for ((i=0; i<dots; i++)); do
        bar="${bar}="
    done
    for ((i=0; i<spaces; i++)); do
        bar="${bar} "
    done
    
    # Print progress on the same line
    printf "\r\033[K[%s] %3d%% - Testing %s (%d/%d)" "$bar" "$percent" "$ip" "$current" "$total"
}

# Header
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}   Testing connection speed to IPs     ${NC}"
echo -e "${BLUE}========================================${NC}"
echo -e "IP File: ${YELLOW}$IP_FILE${NC}"
echo -e "Ping count: ${YELLOW}$PING_COUNT${NC}"
echo -e "Timeout: ${YELLOW}${TIMEOUT}s${NC}"
echo -e "IPs to test: ${YELLOW}${#IPS[@]}${NC}"
echo -e "Color Guide: ${GREEN}🟢 < ${GREEN_THRESHOLD}ms${NC} ${YELLOW}🟡 ${GREEN_THRESHOLD}-${YELLOW_THRESHOLD}ms${NC} ${RED}🔴 > ${YELLOW_THRESHOLD}ms${NC}"
echo ""

# Array to store results
declare -a results
total_ips=${#IPS[@]}
current=0

# Test each IP with progress
for ip in "${IPS[@]}"; do
    current=$((current + 1))
    show_progress $current $total_ips "$ip"
    result=$(ping_ip "$ip")
    results+=("$result")
    # Small delay to ensure progress bar updates properly
    sleep 0.1
done

# Clear progress line and move to next line
echo -e "\n"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}                Results                ${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Display results in a table format
printf "%-20s | %-12s | %-10s | %-12s | %-12s | %-12s\n" "IP Address" "Avg (ms)" "Loss %" "Min (ms)" "Max (ms)" "Mdev"
echo "------------------------------------------------------------------------------------------------------------------------"

best_ip=""
best_time=999999
declare -a reachable_ips=()

for result in "${results[@]}"; do
    IFS='|' read -r ip avg_time packet_loss min_time max_time mdev <<< "$result"
    
    # Clean up values
    avg_time=$(echo "$avg_time" | xargs)
    packet_loss=$(echo "$packet_loss" | xargs)
    min_time=$(echo "$min_time" | xargs)
    max_time=$(echo "$max_time" | xargs)
    mdev=$(echo "$mdev" | xargs)
    
    # Determine color based on response time
    if [ "$avg_time" != "999999" ] && [ "$avg_time" != "" ] && [ "$avg_time" != "-" ]; then
        # Color coding: Green < 100ms, Yellow 100-200ms, Red > 200ms
        if [ "$(compare_float "$avg_time" "$GREEN_THRESHOLD")" -eq 1 ]; then
            color=$GREEN
            emoji="🟢"
        elif [ "$(compare_float "$avg_time" "$YELLOW_THRESHOLD")" -eq 1 ]; then
            color=$YELLOW
            emoji="🟡"
        else
            color=$RED
            emoji="🔴"
        fi
        
        # Format values for display
        avg_display=$(printf "%.1f" "$avg_time")
        min_display=$(printf "%.1f" "$min_time")
        max_display=$(printf "%.1f" "$max_time")
        mdev_display=$(printf "%.1f" "$mdev")
        
        # Track best IP
        if [ "$(compare_float "$avg_time" "$best_time")" -eq 1 ]; then
            best_time=$avg_time
            best_ip="$ip"
        fi
        reachable_ips+=("$ip")
    else
        color=$RED
        emoji="❌"
        avg_display="Unreachable"
        min_display="-"
        max_display="-"
        mdev_display="-"
        packet_loss="100"
    fi
    
    # Format output
    printf "${color}%-20s | %-12s | %-10s | %-12s | %-12s | %-12s${NC}\n" "$ip $emoji" "$avg_display" "${packet_loss}%" "$min_display" "$max_display" "$mdev_display"
done

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}              Summary                  ${NC}"
echo -e "${BLUE}========================================${NC}"

if [ -n "$best_ip" ] && [ "$best_ip" != "" ] && [ ${#reachable_ips[@]} -gt 0 ]; then
    # Determine color for best IP
    if [ "$(compare_float "$best_time" "$GREEN_THRESHOLD")" -eq 1 ]; then
        best_color=$GREEN
        best_emoji="🟢"
    elif [ "$(compare_float "$best_time" "$YELLOW_THRESHOLD")" -eq 1 ]; then
        best_color=$YELLOW
        best_emoji="🟡"
    else
        best_color=$RED
        best_emoji="🔴"
    fi
    
    echo -e "${best_color}✓ Best connection: $best_ip (${best_time}ms average) $best_emoji${NC}"
    echo ""
    echo -e "${CYAN}Ranking by speed (fastest to slowest):${NC}"
    echo ""
    
    # Sort results by avg time and display ranking
    rank=1
    # Create temporary file for sorting
    temp_file=$(mktemp)
    for result in "${results[@]}"; do
        IFS='|' read -r ip avg_time packet_loss min_time max_time mdev <<< "$result"
        avg_time=$(echo "$avg_time" | xargs)
        
        if [ "$avg_time" != "999999" ] && [ "$avg_time" != "" ] && [ "$avg_time" != "-" ]; then
            echo "$avg_time|$ip|$packet_loss|$min_time|$max_time|$mdev" >> "$temp_file"
        fi
    done
    
    if [ -s "$temp_file" ]; then
        sort -n "$temp_file" | while IFS='|' read -r avg ip loss min max mdev; do
            if [ -n "$ip" ]; then
                # Determine color for ranking
                if [ "$(compare_float "$avg" "$GREEN_THRESHOLD")" -eq 1 ]; then
                    rank_color=$GREEN
                    rank_emoji="🟢"
                elif [ "$(compare_float "$avg" "$YELLOW_THRESHOLD")" -eq 1 ]; then
                    rank_color=$YELLOW
                    rank_emoji="🟡"
                else
                    rank_color=$RED
                    rank_emoji="🔴"
                fi
                printf "  ${YELLOW}#%d${NC} ${rank_color}%-20s${NC} - ${rank_color}%.1f ms${NC} (loss: %s%%) %s\n" "$rank" "$ip" "$avg" "$loss" "$rank_emoji"
                rank=$((rank + 1))
            fi
        done
    else
        echo -e "${RED}No reachable IPs to rank${NC}"
    fi
    rm -f "$temp_file"
else
    echo -e "${RED}✗ No reachable IPs found${NC}"
fi

echo ""
