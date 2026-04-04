// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";
import "../src/Payroll.sol";

contract DeployPayroll is Script {
    // ARC testnet KeystoneForwarder
    address constant FORWARDER = 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1;

    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        console.log("Deployer:  ", deployer);
        console.log("Forwarder: ", FORWARDER);
        console.log("Chain ID:  ", block.chainid);

        vm.startBroadcast(deployerKey);
        Payroll payroll = new Payroll(FORWARDER);
        vm.stopBroadcast();

        console.log("Payroll deployed at:", address(payroll));
    }
}
