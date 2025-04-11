import { Blockchain, BlockchainSnapshot, BlockchainTransaction, internal, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano, Dictionary, beginCell, Sender, SendMode, Slice } from '@ton/core';
import { Pool } from '../wrappers/Pool';
import { Controller } from '../wrappers/Controller';
import { JettonMinter as DAOJettonMinter, jettonContentToCell } from '../contracts/jetton_dao/wrappers/JettonMinter';
import { JettonWallet as PoolJettonWallet } from '../wrappers/JettonWallet';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { Conf, Op } from "../PoolConstants";
import { randomAddress } from '../contracts/jetton_dao/tests/utils';
import { Errors } from '../PoolConstants';
import { differentAddress, getRandomInt, getRandomTon } from '../utils';
import { getMsgPrices } from '../fees';
import { flattenTransaction } from '@ton/test-utils';

describe('Governor actions tests', () => {
    let pool_code: Cell;
    let controller_code: Cell;
    let payout_collection: Cell;

    let dao_minter_code: Cell;
    let dao_wallet_code: Cell;
    let dao_vote_keeper_code: Cell;
    let dao_voting_code: Cell;

    let bc: Blockchain;
    let pool: SandboxContract<Pool>;
    let controller: SandboxContract<TreasuryContract>;
    let poolJetton: SandboxContract<DAOJettonMinter>;
    let deployer: SandboxContract<TreasuryContract>;

    let getContractData:(smc:Address) => Promise<Cell>;
    let getContractCode:(smc: Address) => Promise<Cell>;

    let assertExitCode:(txs: BlockchainTransaction[], exit_code: number) => void;
    let sudoOpsAvailable:(via: Sender, expect_exit: number) => Promise<void>;
    let testAddr: Address;
    let execCell: Cell;

    beforeAll(async () => {
        bc       = await Blockchain.create();
        deployer = await bc.treasury('deployer', {workchain: -1, balance: toNano("1000000000")});

        payout_collection = await compile('PayoutNFTCollection');

        pool_code = await compile('Pool');
        controller_code = await compile('Controller');
        // Mock
        controller = await bc.treasury('Controller');

        dao_minter_code = await compile('DAOJettonMinter');
        let dao_wallet_code_raw = await compile('DAOJettonWallet');
        dao_vote_keeper_code = await compile('DAOVoteKeeper');
        dao_voting_code = await compile('DAOVoting');

        //TODO add instead of set
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${dao_wallet_code_raw.hash().toString('hex')}`), dao_wallet_code_raw);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        bc.libs = libs;
        let lib_prep = beginCell().storeUint(2,8).storeBuffer(dao_wallet_code_raw.hash()).endCell();
        dao_wallet_code = new Cell({ exotic:true, bits: lib_prep.bits, refs:lib_prep.refs});

        const content = jettonContentToCell({type:1,uri:"https://example.com/1.json"});
        poolJetton  = bc.openContract(DAOJettonMinter.createFromConfig({
                                                  admin:deployer.address,
                                                  content,
                                                  voting_code:dao_voting_code},
                                                  dao_minter_code));
        let poolConfig = {
              pool_jetton : poolJetton.address,
              pool_jetton_supply : 0n,
              optimistic_deposit_withdrawals: 0n,

              sudoer : randomAddress(),
              governor : deployer.address,
              interest_manager : deployer.address,
              halter : deployer.address,
              approver : deployer.address,

              controller_code : controller_code,
              pool_jetton_wallet_code : dao_wallet_code,
              payout_minter_code : payout_collection,
              vote_keeper_code : dao_vote_keeper_code,
        };

        pool = bc.openContract(Pool.createFromConfig(poolConfig, pool_code));

        const poolDeployResult = await pool.sendDeploy(deployer.getSender(), toNano('11'));

        const poolJettonDeployResult = await poolJetton.sendDeploy(deployer.getSender(), toNano('1.05'));
        const adminTransferResult = await poolJetton.sendChangeAdmin(deployer.getSender(), pool.address);


        // Preparation for the post update execution test
        const sendSlice = Cell.fromBase64("te6ccgEBAQEAJgAASHCAGMjLBVjPFoIQO5rKAPoCy2pwgQU5yMsfyz/J0M8WyXD7AA==").beginParse();
         /*<{
            0 PUSHINT
            24 PUSHINT
            NEWC
            6 STU
            ROT
            STSLICER
            1000000000 PUSHINT
            STVARUINT16
            107 STU
            0 PUSHINT
            1337 PUSHINT
            NEWC
            32 STU
            64 STU
            ENDC
            CTOS
            STSLICER
            ENDC
            0 PUSHINT
            SENDRAWMSG
          }>
         */
        testAddr   = randomAddress();
        const addrSlice  = beginCell().storeAddress(testAddr).asSlice();
        const pushSlice  = beginCell()
                            .storeUint(0x8d, 8) // PUSHSLICE opcode
                            .storeUint(addrSlice.remainingRefs, 3)
                            .storeUint(Math.floor(addrSlice.remainingBits / 8), 7)
                            .storeSlice(addrSlice)
                            .storeUint(1, 1) // Padding required
                            .storeUint(0, 2) // (267 % 8) - 1 slice padding

        execCell = beginCell().storeSlice(pushSlice.endCell().beginParse()).storeSlice(sendSlice).endCell();


        getContractData = async (address: Address) => {
          const smc = await bc.getContract(address);
          if(!smc.account.account)
            throw("Account not found")
          if(smc.account.account.storage.state.type != "active" )
            throw("Atempting to get data on inactive account");
          if(!smc.account.account.storage.state.state.data)
            throw("Data is not present");
          return smc.account.account.storage.state.state.data
        }
        getContractCode = async (address: Address) => {
          const smc = await bc.getContract(address);
          if(!smc.account.account)
            throw("Account not found")
          if(smc.account.account.storage.state.type != "active" )
            throw("Atempting to get code on inactive account");
          if(!smc.account.account.storage.state.state.code)
            throw("Code is not present");
          return smc.account.account.storage.state.state.code;
        }

        assertExitCode = (txs, exit_code) => {

            expect(txs).toHaveTransaction({
                exitCode: exit_code,
                aborted: exit_code != 0,
                success: exit_code == 0
            });
        }
        sudoOpsAvailable = async (via, exp_code) => {
            const testMsg = internal({from: pool.address, to: via.address!, value: toNano('1')});
            const mockCell = beginCell().storeUint(Date.now(), 256).endCell();
            // Intended to check availability only. State should be preserved
            const prevState = bc.snapshot();
            let   res     = await pool.sendSudoMsg(via, 0, testMsg);
            assertExitCode(res.transactions, exp_code);
            res = await pool.sendUpgrade(via, mockCell, mockCell, mockCell);
            assertExitCode(res.transactions, exp_code);
            await bc.loadFrom(prevState);
        }
    });
    describe('Governor', () => {
        let updateTime: number
        let newGovernor: Address;
        let newInterestManager: Address;
        let newHalter: Address;
        let newApprover: Address;
        let newTreasury: Address;
        let prevState: BlockchainSnapshot;
        beforeAll(() => {
            bc.now = Math.floor(Date.now() / 1000);
            newGovernor        = randomAddress();
            newInterestManager = randomAddress();
            newHalter          = randomAddress();
            newApprover        = randomAddress();
            newTreasury        = randomAddress();
            prevState          = bc.snapshot();
        });
        afterAll(async () => {
            await bc.loadFrom(prevState);
        });
        describe('Prepare migration', () => {
            it('Not governor should not be able to trigger migration prep', async() => {
                const notGovernor = differentAddress(deployer.address);
                const updTime     = bc.now! + Conf.governorQuarantine + 1;
                let res = await pool.sendPrepareGovernanceMigration(bc.sender(notGovernor), updTime);
                expect(res.transactions).toHaveTransaction({
                    on: pool.address,
                    from: notGovernor,
                    success: false,
                    aborted: true,
                    exitCode: Errors.wrong_sender
                });
            })
            it('Governor should only be able to set migration time higher than minimal quarantine time', async() => {
                const prevState = bc.snapshot();
                const updTime   = bc.now! + Conf.governorQuarantine;
                let res = await pool.sendPrepareGovernanceMigration(deployer.getSender(), updTime);
                expect(res.transactions).toHaveTransaction({
                    on: pool.address,
                    from: deployer.address,
                    op: Op.governor.prepare_governance_migration,
                    success: false,
                    aborted: true,
                    exitCode: Errors.governor_update_too_soon
                });

                res = await pool.sendPrepareGovernanceMigration(deployer.getSender(), updTime + 1);
                expect(res.transactions).not.toHaveTransaction({
                    on: pool.address,
                    from: deployer.address,
                    op: Op.governor.prepare_governance_migration,
                    success: false,
                    aborted: true,
                    exitCode: Errors.governor_update_too_soon
                });
                await bc.loadFrom(prevState);
            });
            it('Governor should be able to trigger migration prep', async () => {
                const poolBefore = await pool.getFullData();
                const updTime    = bc.now! + Conf.governorQuarantine + getRandomInt(1, 60);
                let res = await pool.sendPrepareGovernanceMigration(deployer.getSender(), updTime);
                expect(res.transactions).toHaveTransaction({
                    on: pool.address,
                    from: deployer.address,
                    op: Op.governor.prepare_governance_migration,
                    success: true
                });
                const poolAfter = await pool.getFullData();
                expect(poolAfter.governorUpdateAfter).toEqual(updTime);
                updateTime = updTime;
            });
        });
        describe('Roles update', () => {
            let assertSetRoles :(txs: Transaction[], res: number, state?: Cell) => Promise<void>;

            beforeAll(async () => {
                expect(newGovernor).not.toEqualAddress(deployer.address);
                assertSetRoles = async (txs, res, state) => {
                    expect(txs).toHaveTransaction({
                        on: pool.address,
                        op: Op.governor.set_roles,
                        success: res == 0,
                        aborted: res != 0,
                        exitCode: res
                    });
                    if(state) {
                        expect(await getContractData(pool.address)).toEqualCell(state);
                    }
                };
            });
            it('Only governor should be able to update roles', async () => {
                const stateBefore = await getContractData(pool.address);
                for(let testAddr of [newApprover, newInterestManager, newHalter, newInterestManager, newGovernor]) {
                    let res = await pool.sendSetRoles(bc.sender(testAddr),
                                                     {governor: newGovernor});

                    await assertSetRoles(res.transactions, Errors.wrong_sender, stateBefore);
                    res = await pool.sendSetRoles(bc.sender(testAddr), {
                                                  interestManager: newInterestManager,
                                                  halter: newHalter,
                                                  approver: newApprover
                                                });

                    await assertSetRoles(res.transactions, Errors.wrong_sender, stateBefore);

                }

                // Should succeed
                const res = await pool.sendSetRoles(deployer.getSender(), {
                                                  interestManager: newInterestManager,
                                                  halter: newHalter,
                                                  approver: newApprover
                                              });


                await assertSetRoles(res.transactions, 0);

                const dataAfter = await pool.getFullData();
                // Should not change
                expect(dataAfter.governor).toEqualAddress(deployer.address);
                // Other roles should
                expect(dataAfter.interestManager).toEqualAddress(newInterestManager);
                expect(dataAfter.halter).toEqualAddress(newHalter);
                expect(dataAfter.approver).toEqualAddress(newApprover);
            });
            // Should we merge it in test above?
            it('Only governor could should be able to set treasury role', async () => {
                const stateBefore = await getContractData(pool.address);

                for(let testAddr of [newApprover, newInterestManager, newHalter, newInterestManager, newGovernor]) {
                    const res = await pool.sendSetRoles(bc.sender(testAddr),{treasury: newTreasury});
                    await assertSetRoles(res.transactions, Errors.wrong_sender, stateBefore);
                }

                const res = await pool.sendSetRoles(deployer.getSender(), {treasury: newTreasury});
                await assertSetRoles(res.transactions, 0);
            });
            it('Till governor quarantine expires no one should be able to trigger governor role', async () => {
                const prevState   = bc.snapshot();
                const poolBefore  = await pool.getFullData();
                const stateBefore = await getContractData(pool.address);
                expect(poolBefore.governorUpdateAfter).toEqual(updateTime);
                expect(bc.now).toBeLessThan(updateTime);

                let res = await pool.sendSetRoles(deployer.getSender(),
                                                  {governor: newGovernor});

                await assertSetRoles(res.transactions, Errors.governor_update_not_matured, stateBefore);
                // No one means no one
                for(let testAddr of [newApprover, newInterestManager, newHalter, newInterestManager, newGovernor]) {
                    res = await pool.sendSetRoles(bc.sender(testAddr),
                                                      {governor: newGovernor});
                    await assertSetRoles(res.transactions, Errors.wrong_sender, stateBefore);
                }

            });
            it('After governance update quarantine expired, only governor should be able to set new governor', async() => {
                bc.now = updateTime + 1;
                const stateBefore = await getContractData(pool.address);
                const poolBefore = await pool.getFullData();
                // Quarantine should not impact roles able to set new governor
                for(let testAddr of [newApprover, newInterestManager, newHalter, newInterestManager, newGovernor]) {
                    const res = await pool.sendSetRoles(bc.sender(testAddr),
                                                      {governor: newGovernor});
                    await assertSetRoles(res.transactions, Errors.wrong_sender, stateBefore);
                }

                const res = await pool.sendSetRoles(deployer.getSender(),
                                                    {governor: newGovernor});

                await assertSetRoles(res.transactions, 0);
                const poolAfter = await pool.getFullData();
                // Should reset update timer
                expect(poolAfter.governorUpdateAfter).toEqual(0xffffffffffff);
                expect(poolAfter.governor).toEqualAddress(newGovernor);
                expect(poolAfter.interestManager).toEqualAddress(newInterestManager);
                expect(poolAfter.halter).toEqualAddress(newHalter)
                expect(poolAfter.approver).toEqualAddress(newApprover);
            });
        });
        describe('Deposit settings', () => {
            it('Only governor should be able to set deposit settings', async () => {
                const rollBack = bc.snapshot();
                const notGovernor    = differentAddress(newGovernor);
                const msgVal = toNano('1');
                const randomFee  = getRandomInt(1, (2 ** 24) - 1);
                const dataBefore = await getContractData(pool.address);
                let res = await pool.sendSetDepositSettings(bc.sender(notGovernor), msgVal, true, true, randomFee);
                assertExitCode(res.transactions, Errors.wrong_sender);
                expect(dataBefore).toEqualCell(await getContractData(pool.address));
                res = await pool.sendSetDepositSettings(bc.sender(newGovernor), msgVal, true, true);
                assertExitCode(res.transactions, 0);
                await bc.loadFrom(rollBack);
            });
            it('Governor should be able to set deposit settings', async() => {
                const randomFee  = getRandomInt(1, (2 ** 24) - 1);
                const poolBefore = await pool.getFullData();
                const optimistic = !poolBefore.optimisticDepositWithdrawals;
                const depoOpened = !poolBefore.depositsOpen;
                const res = await pool.sendSetDepositSettings(bc.sender(newGovernor), toNano('1'), optimistic, depoOpened, randomFee);
                assertExitCode(res.transactions, 0);

                let poolAfter = await pool.getFullData();
                expect(poolAfter.optimisticDepositWithdrawals).toEqual(optimistic);
                expect(poolAfter.depositsOpen).toEqual(depoOpened);
                expect(poolAfter.instantWithdrawalFee).toEqual(randomFee);
            });
            it('halter should be able to disable optimistic/close deposits', async () => {
                let   poolBefore = await pool.getFullData();
                expect(poolBefore.optimisticDepositWithdrawals).toBe(true);

                if(!poolBefore.depositsOpen || !poolBefore.optimisticDepositWithdrawals) {
                    await pool.sendSetDepositSettings(bc.sender(newGovernor), toNano('1'), true, true, poolBefore.instantWithdrawalFee);

                    poolBefore = await pool.getFullData();
                }
                const rollBack = bc.snapshot();

                expect(poolBefore.depositsOpen).toBe(true);
                expect(poolBefore.optimisticDepositWithdrawals).toBe(true);

                for (let params of [[false, false], [true, false], [false, true], [true, true]]) {
                    const res = await pool.sendPartialHalt(bc.sender(newHalter), params[0], params[1]);
                    expect(res.transactions).toHaveTransaction({
                        on: pool.address,
                        from: newHalter,
                        op: Op.halter.partial_halt,
                        aborted: false
                    });
                    const poolAfter = await pool.getFullData();

                    expect(poolAfter.optimisticDepositWithdrawals).toBe(!params[0]);
                    expect(poolAfter.depositsOpen).toBe(!params[1]);
                    // Roll back each iteration
                    await bc.loadFrom(rollBack);
                }
            });
            it('no one except halter should be able to disable optimistic/close deposts', async () => {
                const stateBefore = await getContractData(pool.address);

                for (let addr of [newGovernor, newInterestManager, newApprover]) {
                    expect(addr).not.toEqualAddress(newHalter);
                    const testSender = bc.sender(addr);
                    for (let params of [[false, false], [true, false], [false, true], [true, true]]) {
                        const res = await pool.sendPartialHalt(bc.sender(addr), params[0], params[1]);
                        expect(res.transactions).toHaveTransaction({
                            on: pool.address,
                            from: addr,
                            op: Op.halter.partial_halt,
                            aborted: true,
                            success: false,
                            exitCode: Errors.wrong_sender
                        });
                        expect(await getContractData(pool.address)).toEqualCell(stateBefore);
                    }
                }
            });
            it('should reject malformed partial halt messages', async () => {
                const stateBefore = await getContractData(pool.address);
                // Point is that payload doesn't ocasionally match something meaningfull
                const extraTrue   = beginCell().storeBit(true).endCell();
                const extraFalse  = beginCell().storeBit(false).endCell();
                const bitLength   = getRandomInt(2, 32);
                const appendBits  = getRandomInt(0, (1 << bitLength ) - 1);
                const extraSome   = beginCell().storeUint(appendBits, bitLength).endCell();

                const halter      = bc.sender(newHalter);

                for (let params of [[false, false], [true, false], [false, true], [true, true]]) {
                    const validMsg = Pool.partialHaltMessage(params[0], params[1]);
                    for(let extra of [extraTrue, extraFalse, extraSome]) {
                        const res = await bc.sendMessage(internal({
                            from: newHalter,
                            to: pool.address,
                            body: beginCell().storeSlice(validMsg.asSlice()).storeSlice(extra.asSlice()).endCell(),
                            value: toNano('0.1'),
                        }));
                        expect(res.transactions).toHaveTransaction({
                            on: pool.address,
                            op: Op.halter.partial_halt,
                            success: false,
                        });
                        expect(await getContractData(pool.address)).toEqualCell(stateBefore);
                    }
                }
            });
            it('Closing deposit should prevent anyone from furhter deposits', async() => {
                const poolBefore = await pool.getFullData();
                const governor   = bc.sender(newGovernor);
                const depoAmount = getRandomTon(100000, 200000);
                if(poolBefore.depositsOpen) {
                    await pool.sendSetDepositSettings(governor, toNano('1'), poolBefore.optimisticDepositWithdrawals, false);
                }

                // Not even governor
                let res = await pool.sendDeposit(governor, depoAmount);
                assertExitCode(res.transactions, Errors.depossits_are_closed);
                // Let's test random address too just in case
                res = await pool.sendDeposit(bc.sender(randomAddress()), depoAmount);
                assertExitCode(res.transactions, Errors.depossits_are_closed);
                await pool.sendSetDepositSettings(governor, toNano('1'), true, true);
            });
        });
        describe('Governance fee setting', () => {
            it('Not governor should not be able to set governance fee', async () => {
                const poolBefore  = await pool.getFullData();
                const maxFee      = (1 << 24) - 1;
                const newFee      = (poolBefore.governanceFee + getRandomInt(100, 200)) % maxFee;
                const notGovernor = differentAddress(newGovernor);
                const res = await pool.sendSetGovernanceFee(bc.sender(notGovernor), newFee);
                assertExitCode(res.transactions, Errors.wrong_sender);
            });
            it('Governor should be able to set governance fee', async() => {
                const poolBefore = await pool.getFullData();
                const maxFee      = (1 << 24) - 1;
                const newFee      = (poolBefore.governanceFee + getRandomInt(100, 200)) % maxFee;
                const res = await pool.sendSetGovernanceFee(bc.sender(newGovernor), newFee);
                assertExitCode(res.transactions, 0);

                const poolAfter = await pool.getFullData();
                expect(poolAfter.governanceFee).toEqual(newFee);
            });
        });
        describe('Interest setting', () => {
            it('Only interest manager should be able to set interest', async () => {
                const poolBefore  = await pool.getFullData();
                const maxInterest = (1 << 24) - 1;
                const newInterest = (poolBefore.interestRate + getRandomInt(100, 200)) % maxInterest;
                const randomUser  = bc.sender(differentAddress(newInterestManager));
                const governor    = bc.sender(newGovernor);

                let res = await pool.sendSetInterest(randomUser, newInterest);

                assertExitCode(res.transactions, Errors.wrong_sender);
                // Make sure those are separate roles
                res = await pool.sendSetInterest(governor, newInterest);
                assertExitCode(res.transactions, Errors.wrong_sender);
            });
            it('Interest manager should be able to set interest', async() => {
                const poolBefore  = await pool.getFullData();
                const maxInterest = (1 << 24) - 1;
                const newInterest    = (poolBefore.interestRate + getRandomInt(100, 200)) % maxInterest;

                const res = await pool.sendSetInterest(bc.sender(newInterestManager), newInterest);
                assertExitCode(res.transactions, 0);

                const poolAfter = await pool.getFullData();
                expect(poolAfter.interestRate).toEqual(newInterest);
            });
        });
        describe('Halting', () => {
            it('Only halter should be able to halt pool', async() => {
                const notHalter = differentAddress(newHalter);

                let res = await pool.sendHaltMessage(bc.sender(notHalter));
                assertExitCode(res.transactions, Errors.wrong_sender);
                // Make sure it's separate role
                res = await pool.sendHaltMessage(bc.sender(newGovernor));
                assertExitCode(res.transactions, Errors.wrong_sender);
            });
            it('Halter should be able to halt pool', async () => {
                const poolBefore = await pool.getFullData();
                // deposit while we can
                const depositResult = await pool.sendDeposit(deployer.getSender(), toNano('10'));
                expect(depositResult.transactions).toHaveTransaction({
                    on: deployer.address,
                    op: Op.jetton.transfer_notification
                });

                expect(poolBefore.halted).toBe(false);

                const res = await pool.sendHaltMessage(bc.sender(newHalter));
                assertExitCode(res.transactions, 0);

                const poolAfter = await pool.getFullData();
                expect(poolAfter.halted).toBe(true);
            });
            it('Pool in halted state should prevent haltable ops', async () => {
                const haltedOps = [
                    // Withdraw is not haltable since in any case we need handle and send jettons back
                    async () => pool.sendDeposit(bc.sender(randomAddress()), getRandomTon(100000, 200000)),
                    // Loan request
                    async () => bc.sendMessage(internal({
                        from: controller.address,
                        to: pool.address,
                        value: toNano('1'),
                        body: beginCell()
                                .storeUint(Op.pool.request_loan, 32)
                                .storeUint(1, 64)
                                .storeCoins(toNano('100000'))
                                .storeCoins(toNano('100000'))
                                .storeUint(100, 24)
                              .endCell()
                    })),

                    async () => bc.sendMessage(internal({
                        from: controller.address,
                        to: pool.address,
                        value: toNano('100000'),
                        body: beginCell()
                                .storeUint(Op.pool.loan_repayment, 32)
                                .storeUint(1, 64)
                              .endCell()
                    })),
                    async () => pool.sendTouch(deployer.getSender()),
                    async () => pool.sendRequestControllerDeploy(bc.sender(newGovernor), toNano('1000'), 1),
                    async () => pool.sendDonate(bc.sender(newGovernor), toNano('1'))
                ];

                for (let cb of haltedOps) {
                    const res = await cb();
                    expect(res.transactions).toHaveTransaction({
                        success: false,
                        aborted: true,
                        exitCode: Errors.halted
                    });
                }

                //Check remint on withdrawal for halted pool
                let myPoolJettonWalletAddress = await poolJetton.getWalletAddress(deployer.address);
                let myPoolJettonWallet = bc.openContract(PoolJettonWallet.createFromAddress(myPoolJettonWalletAddress));
                let oldJettonAmount = await myPoolJettonWallet.getJettonBalance();
                let oldBalance = (await bc.getContract(deployer.address)).balance;
                let burnResult = await myPoolJettonWallet.sendBurnWithParams(deployer.getSender(), toNano('1.0'), toNano('1.0'), deployer.address, true, true);
                expect(burnResult.transactions).toHaveTransaction({
                    on: pool.address,
                    success: true
                });
                expect(burnResult.transactions).toHaveTransaction({
                    on: deployer.address,
                    op: Op.jetton.transfer_notification
                });
                expect((await bc.getContract(deployer.address)).balance - oldBalance < 0n).toBeTruthy();
                expect(oldJettonAmount - await myPoolJettonWallet.getJettonBalance()).toEqual(0n);
            });
            it('Governance ops should be possible when halted', async() => {
                const rollBack = bc.snapshot();
                const governor    = bc.sender(newGovernor);
                const notHaltable = [
                    async () => pool.sendSudoMsg(bc.sender(newGovernor), 0, internal({
                        from: pool.address,
                        to: deployer.address,
                        value: toNano('1'),
                        body: beginCell().endCell()
                    })),
                    async () => pool.sendUpgrade(governor, null, null, null),
                    async () => pool.sendSetSudoer(governor, randomAddress()),
                    // We don't want halt state to change here
                    async () => pool.sendUnhalt(bc.sender(randomAddress())),
                    async () => pool.sendPrepareGovernanceMigration(governor, Math.floor(Date.now() / 1000)),
                    async () => pool.sendSetRoles(governor, {}),
                    async () => pool.sendSetDepositSettings(governor, toNano('1'), true, true),
                    async () => pool.sendSetGovernanceFee(governor, 0),
                    async () => pool.sendSetInterest(bc.sender(newInterestManager), 0)
                ];

                for (let cb of notHaltable) {
                    const res = await cb();
                    expect(res.transactions).not.toHaveTransaction({
                        on: pool.address,
                        exitCode: Errors.halted
                    });
                }

                await bc.loadFrom(rollBack);
            });
            it('Only governor should be able to unhalt', async () => {
                const poolBefore = await pool.getFullData();
                expect(poolBefore.halted).toBe(true);
                let res = await pool.sendUnhalt(bc.sender(newHalter));
                assertExitCode(res.transactions, Errors.wrong_sender);
                res = await pool.sendUnhalt(bc.sender(newGovernor));
                assertExitCode(res.transactions, 0);

                const poolAfter = await pool.getFullData();
                expect(poolAfter.halted).toBe(false);
            });
        });
    });
    describe('Sudoer', () => {
    it('Not sudoer should not be able to use sudoer request', async() => {
        const poolBefore = await pool.getFullData();
        expect(poolBefore.governor).toEqualAddress(deployer.address);
        // Make sure governor is not special role for sudoer operations
        await sudoOpsAvailable(deployer.getSender(), Errors.wrong_sender);
        // Not sudoer should not have access to sudoer operations
        const notSudoer = bc.sender(differentAddress(poolBefore.sudoer));
        await sudoOpsAvailable(notSudoer, Errors.wrong_sender);
    });
    it('Governor should be able to set sudoer', async() => {
        const poolBefore = await pool.getFullData();
        expect(poolBefore.sudoer).not.toEqualAddress(deployer.address);
        const res = await pool.sendSetSudoer(deployer.getSender(), deployer.address);
        const poolAfter = await pool.getFullData();
        expect(poolAfter.sudoer).toEqualAddress(deployer.address);
        expect(poolAfter.sudoerSetAt).toEqual(res.transactions[1].now);
    });
    it('Sudo actions should not be available till quoarantine time passes', async () => {
        const poolBefore = await pool.getFullData();
        expect(poolBefore.sudoer).toEqualAddress(deployer.address);
        await sudoOpsAvailable(deployer.getSender(), Errors.sudoer.quarantine);
    });
    it('Sudo ops should become available after quarantine time passed', async () => {
        const poolBefore = await pool.getFullData();
        expect(poolBefore.sudoer).toEqualAddress(deployer.address);
        const curTime = bc.now ? bc.now : Math.floor(Date.now() / 1000);

        expect(curTime).toBeLessThanOrEqual(poolBefore.sudoerSetAt + Conf.sudoQuarantine);

        bc.now = poolBefore.sudoerSetAt + Conf.sudoQuarantine + 1;
        await sudoOpsAvailable(deployer.getSender(), 0);
    });
    it('Sudoer should be able to send arbitrary message', async() => {
        const prevState = bc.snapshot();
        let msgConf = getMsgPrices(bc.config, -1);
 
        const poolBefore = await pool.getFullData();
        expect(poolBefore.sudoer).toEqualAddress(deployer.address);
        const msgVal  = getRandomTon(1, 10);
        const curTime = Date.now();
        const testMsg = internal({
            from: pool.address,
            to: deployer.address,
            value: msgVal,
            body: beginCell().storeUint(curTime, 64).endCell()
        });

        let res = await pool.sendSudoMsg(deployer.getSender(), SendMode.NONE, testMsg);
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: deployer.address,
            value: msgVal - msgConf.lumpPrice
        });
        await bc.loadFrom(prevState);

        // Send mode should be taken into account
        res = await pool.sendSudoMsg(deployer.getSender(), SendMode.PAY_GAS_SEPARATELY, testMsg)
        expect(res.transactions).toHaveTransaction({
            from: pool.address,
            to: deployer.address,
            value: msgVal
        });
        await bc.loadFrom(prevState);
    });
    it('Sudoer should be able to upgrade contract', async() => {
        const poolBefore = await pool.getFullData();
        expect(poolBefore.sudoer).toEqualAddress(deployer.address);
        const prevState  = bc.snapshot();
        const dataBefore = await getContractData(pool.address);
        const codeBefore = await getContractData(pool.address);
        const mockCell = beginCell().storeUint(Date.now(), 64).endCell();

        const res = await pool.sendUpgrade(deployer.getSender(), mockCell, mockCell, execCell);
        expect(await getContractData(pool.address)).toEqualCell(mockCell);
        expect(await getContractCode(pool.address)).toEqualCell(mockCell);

        expect(res.transactions).toHaveTransaction({
          from: pool.address,
          to: testAddr,
          op: 1337
        });
        await bc.loadFrom(prevState);
    });
    it('Upgrade should not impact code/data when if not specified', async() => {
        const prevState = bc.snapshot();
        const codeBefore = await getContractCode(pool.address);
        const dataBefore = await getContractData(pool.address);
        const mockCell = beginCell().storeUint(Date.now(), 64).endCell();

        let res = await pool.sendUpgrade(deployer.getSender(), mockCell, null, null); // Only data
        expect(await getContractData(pool.address)).toEqualCell(mockCell);
        expect(await getContractCode(pool.address)).toEqualCell(codeBefore);
        await bc.loadFrom(prevState);

        res = await pool.sendUpgrade(deployer.getSender(), null, mockCell, null); // Only code
        expect(await getContractData(pool.address)).toEqualCell(dataBefore);
        expect(await getContractCode(pool.address)).toEqualCell(mockCell);
        await bc.loadFrom(prevState);

        res = await pool.sendUpgrade(deployer.getSender(), null, null, execCell); // Only execution should be possible
        expect(await getContractData(pool.address)).toEqualCell(dataBefore);
        expect(await getContractCode(pool.address)).toEqualCell(codeBefore);
        expect(res.transactions).toHaveTransaction({
          from: pool.address,
          to: testAddr
        });
        await bc.loadFrom(prevState);
    });
    });
});
