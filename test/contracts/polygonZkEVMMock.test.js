/* eslint-disable no-plusplus, no-await-in-loop */
const { expect } = require('chai');
const { ethers, upgrades } = require('hardhat');

describe('Polygon ZK-EVM Mock', () => {
    let deployer;
    let trustedAggregator;
    let trustedSequencer;
    let admin;

    let verifierContract;
    let polygonZkEVMBridgeContract;
    let polygonZkEVMContract;
    let maticTokenContract;
    let polygonZkEVMGlobalExitRoot;

    const maticTokenName = 'Matic Token';
    const maticTokenSymbol = 'MATIC';
    const maticTokenInitialBalance = ethers.utils.parseEther('20000000');

    const genesisRoot = '0x0000000000000000000000000000000000000000000000000000000000000001';

    const networkIDMainnet = 0;
    const urlSequencer = 'http://zkevm-json-rpc:8123';
    const chainID = 1000;
    const networkName = 'zkevm';
    const version = '0.0.1';
    const forkID = 0;
    const pendingStateTimeoutDefault = 100;
    const trustedAggregatorTimeoutDefault = 10;
    let firstDeployment = true;

    // PolygonZkEVM Constants
    const FORCE_BATCH_TIMEOUT = 60 * 60 * 24 * 5; // 5 days
    beforeEach('Deploy contract', async () => {
        upgrades.silenceWarnings();

        // load signers
        [deployer, trustedAggregator, trustedSequencer, admin] = await ethers.getSigners();

        // deploy mock verifier
        const VerifierRollupHelperFactory = await ethers.getContractFactory(
            'VerifierRollupHelperMock',
        );
        verifierContract = await VerifierRollupHelperFactory.deploy();

        // deploy MATIC
        const maticTokenFactory = await ethers.getContractFactory('ERC20PermitMock');
        maticTokenContract = await maticTokenFactory.deploy(
            maticTokenName,
            maticTokenSymbol,
            deployer.address,
            maticTokenInitialBalance,
        );
        await maticTokenContract.deployed();

        /*
         * deploy global exit root manager
         * In order to not have trouble with nonce deploy first proxy admin
         */
        await upgrades.deployProxyAdmin();
        if ((await upgrades.admin.getInstance()).address !== '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0') {
            firstDeployment = false;
        }
        const nonceProxyBridge = Number((await ethers.provider.getTransactionCount(deployer.address))) + (firstDeployment ? 3 : 2);
        const nonceProxyZkevm = nonceProxyBridge + 2; // Always have to redeploy impl since the polygonZkEVMGlobalExitRoot address changes

        const precalculateBridgeAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyBridge });
        const precalculateZkevmAddress = ethers.utils.getContractAddress({ from: deployer.address, nonce: nonceProxyZkevm });
        firstDeployment = false;

        const PolygonZkEVMGlobalExitRootFactory = await ethers.getContractFactory('PolygonZkEVMGlobalExitRoot');
        polygonZkEVMGlobalExitRoot = await upgrades.deployProxy(PolygonZkEVMGlobalExitRootFactory, [], {
            initializer: false,
            constructorArgs: [precalculateZkevmAddress, precalculateBridgeAddress],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        // deploy PolygonZkEVMBridge
        const polygonZkEVMBridgeFactory = await ethers.getContractFactory('PolygonZkEVMBridge');
        polygonZkEVMBridgeContract = await upgrades.deployProxy(polygonZkEVMBridgeFactory, [], { initializer: false });

        // deploy PolygonZkEVMMock
        const PolygonZkEVMFactory = await ethers.getContractFactory('PolygonZkEVMMock');
        polygonZkEVMContract = await upgrades.deployProxy(PolygonZkEVMFactory, [], {
            initializer: false,
            constructorArgs: [
                polygonZkEVMGlobalExitRoot.address,
                maticTokenContract.address,
                verifierContract.address,
                polygonZkEVMBridgeContract.address,
                chainID,
                forkID,
            ],
            unsafeAllow: ['constructor', 'state-variable-immutable'],
        });

        expect(precalculateBridgeAddress).to.be.equal(polygonZkEVMBridgeContract.address);
        expect(precalculateZkevmAddress).to.be.equal(polygonZkEVMContract.address);

        await polygonZkEVMBridgeContract.initialize(networkIDMainnet, polygonZkEVMGlobalExitRoot.address, polygonZkEVMContract.address);
        await polygonZkEVMContract.initialize(
            {
                admin: admin.address,
                trustedSequencer: trustedSequencer.address,
                pendingStateTimeout: pendingStateTimeoutDefault,
                trustedAggregator: trustedAggregator.address,
                trustedAggregatorTimeout: trustedAggregatorTimeoutDefault,
            },
            genesisRoot,
            urlSequencer,
            networkName,
            version,
        );

        // fund sequencer address with Matic tokens
        await maticTokenContract.transfer(trustedSequencer.address, ethers.utils.parseEther('1000'));
    });

    it('should check the constructor parameters', async () => {
        expect(await polygonZkEVMContract.forcedBatchesAllowed()).to.be.equal(0);
        expect(await polygonZkEVMContract.forceBatchTimeout()).to.be.equal(0);
    });

    it('should check forcedBatchesAllowed', async () => {
        await expect(polygonZkEVMContract.connect(admin).setForcedBatchesAllowed(1))
            .to.be.revertedWith('Ownable:');
        await polygonZkEVMContract.connect(deployer).setForcedBatchesAllowed(1);

        const l2txDataForceBatch = '0x123456';
        const maticAmount = await polygonZkEVMContract.getCurrentBatchFee();

        await expect(polygonZkEVMContract.forceBatch(l2txDataForceBatch, maticAmount))
            .to.be.revertedWith('ForceBatchNowAllowed');
        await expect(polygonZkEVMContract.sequenceForceBatches([]))
            .to.be.revertedWith('ForceBatchNowAllowed');

        expect(await polygonZkEVMContract.getForceBatchTimeout()).to.be.equal(FORCE_BATCH_TIMEOUT);

        await expect(polygonZkEVMContract.connect(admin).setForceBatchTimeout(1))
            .to.be.revertedWith('Ownable:');
        await polygonZkEVMContract.connect(deployer).setForceBatchTimeout(1);
        expect(await polygonZkEVMContract.getForceBatchTimeout()).to.be.equal(1);
    });
});
