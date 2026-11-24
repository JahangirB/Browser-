#!/usr/bin/env bash
# One-time host preparation for a fresh Oracle Cloud Ubuntu 24.04 (aarch64) VM.
# Read it before running. Usage:  bash scripts/setup-host.sh
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "==> 1/4 Opening ports 80 and 443 in the host firewall"
# Oracle's Ubuntu images ship iptables rules that REJECT everything except SSH.
# Do this BEFORE installing Docker so we don't persist Docker's own rules.
sudo apt-get update
sudo apt-get install -y iptables-persistent
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null \
    || sudo iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
done
sudo iptables -C INPUT -p udp --dport 443 -j ACCEPT 2>/dev/null \
  || sudo iptables -I INPUT 1 -p udp --dport 443 -j ACCEPT
sudo netfilter-persistent save

echo "==> 2/4 Installing Docker from Ubuntu's own repositories"
sudo apt-get install -y docker.io docker-compose-v2 git openssl curl
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"

echo "==> 3/4 Adding 4 GB swap (cushion against memory spikes)"
if ! swapon --show | grep -q '^/swapfile'; then
  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
fi

echo "==> 4/4 Enabling automatic security updates"
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -f noninteractive unattended-upgrades

echo
echo "Done. Log out and back in (so the 'docker' group applies), then continue with README step 6."
