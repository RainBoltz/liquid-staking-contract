import { Address, toNano } from 'ton-core';
import { Pool } from '../wrappers/Pool';
import { NetworkProvider } from '@ton-community/blueprint';



export async function run(provider: NetworkProvider) {

    const poolAddressString = await provider.ui().input("Please enter pool address:");
    const poolAddress = Address.parse(poolAddressString);

    const amount = await provider.ui().input("Please enter amount:");

    const confirmed = await provider.ui().prompt(`Donate ${amount} TON to ${poolAddress}`);
    if (!confirmed) {
        return;
    }

    const sender = provider.sender();
    const pool = provider.open(Pool.createFromAddress(poolAddress));

    await pool.sendDonate(sender, toNano(amount)); //compensate round finalize fee
}
