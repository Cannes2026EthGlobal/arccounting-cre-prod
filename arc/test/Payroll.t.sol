// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";
import "../src/Payroll.sol";

contract PayrollTest is Test {
    Payroll payroll;
    address forwarder = address(0xF0);
    address owner;
    address recipient = address(0xBEEF);

    function setUp() public {
        owner = address(this);
        payroll = new Payroll(forwarder);
    }

    // ── Constructor ─────────────────────────────────────────────────────────

    function test_Constructor_SetsForwarder() public view {
        assertEq(payroll.getForwarderAddress(), forwarder);
    }

    function test_Constructor_SetsOwner() public view {
        assertEq(payroll.owner(), owner);
    }

    function test_Constructor_RevertsOnZeroForwarder() public {
        vm.expectRevert(ReceiverTemplate.InvalidForwarderAddress.selector);
        new Payroll(address(0));
    }

    // ── Deposit ─────────────────────────────────────────────────────────────

    function test_Deposit_UpdatesBalance() public {
        payroll.deposit{value: 1 ether}();
        assertEq(payroll.contractBalance(), 1 ether);
    }

    function test_Deposit_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit Payroll.FundsDeposited(address(this), 1 ether);
        payroll.deposit{value: 1 ether}();
    }

    function test_Receive_UpdatesBalance() public {
        (bool ok,) = address(payroll).call{value: 2 ether}("");
        assertTrue(ok);
        assertEq(payroll.contractBalance(), 2 ether);
    }

    function test_Receive_EmitsEvent() public {
        vm.expectEmit(true, false, false, true);
        emit Payroll.FundsDeposited(address(this), 0.5 ether);
        (bool ok,) = address(payroll).call{value: 0.5 ether}("");
        assertTrue(ok);
    }

    // ── _processReport (via onReport) ────────────────────────────────────────

    function _callOnReport(address _recipient, uint256 _amount) internal {
        bytes memory report = abi.encode(_recipient, _amount);
        bytes memory metadata = new bytes(74); // empty metadata — skips identity checks
        vm.prank(forwarder);
        payroll.onReport(metadata, report);
    }

    function test_Pay_SendsFunds() public {
        payroll.deposit{value: 10 ether}();
        uint256 before = recipient.balance;
        _callOnReport(recipient, 1 ether);
        assertEq(recipient.balance, before + 1 ether);
        assertEq(payroll.contractBalance(), 9 ether);
    }

    function test_Pay_EmitsEvent() public {
        payroll.deposit{value: 5 ether}();
        vm.expectEmit(true, false, false, true);
        emit Payroll.PaymentSent(recipient, 1 ether);
        _callOnReport(recipient, 1 ether);
    }

    function test_Pay_RevertsOnZeroAmount() public {
        payroll.deposit{value: 1 ether}();
        vm.expectRevert(Payroll.ZeroAmount.selector);
        _callOnReport(recipient, 0);
    }

    function test_Pay_RevertsOnZeroAddress() public {
        payroll.deposit{value: 1 ether}();
        vm.expectRevert(Payroll.ZeroAddress.selector);
        _callOnReport(address(0), 1 ether);
    }

    function test_Pay_RevertsOnInsufficientBalance() public {
        payroll.deposit{value: 1 ether}();
        vm.expectRevert(
            abi.encodeWithSelector(Payroll.InsufficientBalance.selector, 1 ether, 2 ether)
        );
        _callOnReport(recipient, 2 ether);
    }

    function test_Pay_RevertsIfCallerNotForwarder() public {
        payroll.deposit{value: 1 ether}();
        bytes memory report = abi.encode(recipient, 1 ether);
        bytes memory metadata = new bytes(74);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, address(this), forwarder)
        );
        payroll.onReport(metadata, report);
    }

    function test_Pay_RevertsOnReentrancy() public {
        ReentrantRecipient attacker = new ReentrantRecipient(payroll, forwarder);
        payroll.deposit{value: 10 ether}();
        bytes memory report = abi.encode(address(attacker), 1 ether);
        bytes memory metadata = new bytes(74);
        // Reentrancy guard fires inside the call, causing TransferFailed to bubble up
        vm.prank(forwarder);
        vm.expectRevert(
            abi.encodeWithSelector(Payroll.TransferFailed.selector, address(attacker), 1 ether)
        );
        payroll.onReport(metadata, report);
    }

    // ── contractBalance ──────────────────────────────────────────────────────

    function test_ContractBalance_StartsZero() public view {
        assertEq(payroll.contractBalance(), 0);
    }

    function test_ContractBalance_AfterDeposit() public {
        payroll.deposit{value: 3 ether}();
        assertEq(payroll.contractBalance(), 3 ether);
    }

    // ── Fuzz ────────────────────────────────────────────────────────────────

    function testFuzz_Deposit(uint96 amount) public {
        vm.assume(amount > 0);
        payroll.deposit{value: amount}();
        assertEq(payroll.contractBalance(), amount);
    }

    function testFuzz_Pay_WithinBalance(uint96 deposit, uint96 pay) public {
        vm.assume(deposit > 0 && pay > 0 && pay <= deposit);
        payroll.deposit{value: deposit}();
        uint256 before = recipient.balance;
        _callOnReport(recipient, pay);
        assertEq(recipient.balance, before + pay);
        assertEq(payroll.contractBalance(), deposit - pay);
    }

    receive() external payable {}
}

/// @dev Attempts reentrancy when it receives funds
contract ReentrantRecipient {
    Payroll payroll;
    address forwarder;

    constructor(Payroll _payroll, address _forwarder) {
        payroll = _payroll;
        forwarder = _forwarder;
    }

    receive() external payable {
        // Try to re-enter
        bytes memory report = abi.encode(address(this), 1 ether);
        bytes memory metadata = new bytes(74);
        vm.prank(forwarder); // won't work in inner call but triggers the lock check
        payroll.onReport(metadata, report);
    }

    // Expose vm for test purposes
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
}
