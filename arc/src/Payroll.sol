// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/**
 * =============================================================================
 * Payroll — CRE-triggered payroll on ARC testnet
 * =============================================================================
 *
 * HOW PAYMENTS ARE TRIGGERED:
 *
 *   CRE Workflow (WASM on DON)
 *       └── evmClient.writeReport(report, { receiver: THIS_CONTRACT })
 *               │
 *               ▼
 *       KeystoneForwarder (0x6E9EE680...)
 *           1. Verifies DON node signatures
 *           2. Calls this contract: onReport(metadata, report)
 *               │
 *               ▼
 *       _processReport(report)
 *           - Decodes: (address recipient, uint256 amount)
 *           - Sends: recipient.call{value: amount}("")
 *
 * FUNDING:
 *   Anyone can deposit native USDC (the native token on ARC) via deposit()
 *   or plain transfers. The contract holds the funds until CRE triggers a pay.
 *
 * SECURITY:
 *   - Only the KeystoneForwarder can call onReport() (ReceiverTemplate check)
 *   - Reentrancy guard on _processReport
 *   - Checks-Effects-Interactions ordering
 *   - Custom errors for all revert cases
 * =============================================================================
 */
contract Payroll is ReceiverTemplate {
    bool private _locked;

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance(uint256 available, uint256 requested);
    error TransferFailed(address recipient, uint256 amount);
    error Reentrancy();

    event FundsDeposited(address indexed sender, uint256 amount);
    event PaymentSent(address indexed recipient, uint256 amount);

    constructor(address _forwarderAddress) ReceiverTemplate(_forwarderAddress) {}

    /// @notice Fund the contract with native USDC.
    function deposit() external payable {
        emit FundsDeposited(msg.sender, msg.value);
    }

    /// @notice Accept plain native USDC transfers.
    receive() external payable {
        emit FundsDeposited(msg.sender, msg.value);
    }

    /// @notice Current native USDC balance held by the contract.
    function contractBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /**
     * @dev Called by ReceiverTemplate.onReport() after Forwarder signature verification.
     * @param report ABI-encoded (address recipient, uint256 amount)
     *
     * In the CRE workflow (TypeScript):
     *   const encoded = encodeAbiParameters(
     *     parseAbiParameters('address, uint256'),
     *     [recipientAddress, amount]
     *   )
     *   const report = runtime.report(prepareReportRequest(encoded)).result()
     *   evmClient.writeReport(runtime, { receiver: payrollAddress, report, gasConfig })
     */
    function _processReport(bytes calldata report) internal override {
        if (_locked) revert Reentrancy();
        _locked = true;

        (address recipient, uint256 amount) = abi.decode(report, (address, uint256));

        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (address(this).balance < amount) {
            revert InsufficientBalance(address(this).balance, amount);
        }

        emit PaymentSent(recipient, amount);

        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert TransferFailed(recipient, amount);

        _locked = false;
    }
}
