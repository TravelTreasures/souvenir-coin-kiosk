# Hardware bring-up tests

Small standalone programs to prove each adapter is wired and talking **before**
trusting the full kiosk app. They print every byte sent/received so we can
calibrate against the real devices.

Run them on the **mini-PC**, from the app folder, **after `npm install`**:

```bash
cd ~/kiosk-app

# find which USB serial port is which
ls /dev/serial/by-id/      # (or: ls /dev/ttyUSB*)

# one-off permission to use serial ports (then log out & back in)
sudo usermod -aG dialout $USER
```

## 1. Hoppers (ccTalk)

```bash
node scripts/bringup/hopper-test.mjs <port> <address> <coins>
# Hopper 1 (address 3), dispense 1 coin:
node scripts/bringup/hopper-test.mjs /dev/ttyUSB0 3 1
# Hopper 2 (address 4):
node scripts/bringup/hopper-test.mjs /dev/ttyUSB0 4 1
```

It polls the hopper, reads its serial number, enables it, dispenses the coins,
and reports how many actually came out. If it fails, it lists what to check
(port, DIP address, board jumpers = USB→ccTalk, power).

## 2. Nayax card reader (MDB via Waferstar)

```bash
node scripts/bringup/nayax-test.mjs <port> <priceCents>
node scripts/bringup/nayax-test.mjs /dev/ttyUSB1 100
```

It configures and enables the reader, waits for you to **tap a card**, requests a
test vend, shows the approval — then **cancels the vend so no money is captured**.
The Nayax reader must be active on Nayax's server for a session to start.

## Notes

- These use the `serialport` library from `node_modules`, built for Node during
  `npm install`. If you run them *after* building the `.deb` and see a
  "NODE_MODULE_VERSION" / native-module error, run `npm rebuild serialport` first.
- Ports: the hopper interface (107-0251) and the Waferstar box are two **separate**
  USB serial ports. Use the stable `/dev/serial/by-id/...` names to be sure which
  is which, and set `HOPPER_PORT` / `NAYAX_PORT` for the app accordingly.
