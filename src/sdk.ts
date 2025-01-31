import { Domain, DomainStorageValue, Record, RecordKey, RecordType, SorobanDomainsSDKParams, SubDomain } from './types';
import { Hasher, keccak256 } from 'js-sha3';
import { Buffer } from 'buffer';
import { Domain404Error, DomainData404Error, DomainDataUnsupportedValueType } from './errors';
import { Account, Contract, SorobanRpc, Transaction, xdr } from '@stellar/stellar-sdk';

export class SorobanDomainsSDK {
  constructor(public global: SorobanDomainsSDKParams) {}

  /**
   * This function takes a domain and generates the "node" value of the parsed domain.
   * This "node" value can be used to fetch data from the contract (either if is a Record or a SubRecord)
   */
  static parseDomain(params: { domain: string; subDomain?: string }): string {
    const record: Hasher = keccak256
      .create()
      .update(keccak256.create().update('xlm').digest())
      .update(keccak256.create().update(params.domain).digest());

    if (params.subDomain) {
      const subRecord: Hasher = keccak256
        .create()
        .update(keccak256.create().update(record.digest()).digest())
        .update(keccak256.create().update(params.subDomain).digest());

      return subRecord.hex();
    } else {
      return record.hex();
    }
  }

  /**
   * This function parses the domain you want to use, and it will search it in the contract.
   * This function doesn't validate the domain you're providing is a valid one.
   */
  async searchDomain(params: { domain: string; subDomain?: string }): Promise<Record> {
    if (!this.global.vaultsContractId) {
      throw new Error(`Vault's contract id was not provided`);
    }

    const domainNode: string = SorobanDomainsSDK.parseDomain({
      domain: params.domain,
      subDomain: params.subDomain,
    });

    const contract: Contract = new this.global.stellarSDK.Contract(this.global.vaultsContractId);
    const nodeBytes: xdr.ScVal = this.global.stellarSDK.xdr.ScVal.scvBytes(Buffer.from(domainNode, 'hex'));

    const record_key: xdr.ScVal = this.global.stellarSDK.xdr.ScVal.scvVec([
      this.global.stellarSDK.xdr.ScVal.scvSymbol(params.subDomain ? RecordKey.SubRecord : RecordKey.Record),
      nodeBytes,
    ]);

    const account: Account = await this.global.rpc.getAccount(this.global.simulationAccount);

    const transaction: Transaction = new this.global.stellarSDK.TransactionBuilder(account, {
      networkPassphrase: this.global.network,
      fee: this.global.defaultFee,
    })
      .setTimeout(this.global.defaultTimeout || 0)
      .addOperation(contract.call('record', record_key))
      .build();

    const sim: SorobanRpc.Api.SimulateTransactionResponse = await this.global.rpc.simulateTransaction(transaction);

    if (this.global.stellarSDK.SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }

    const result = this.global.stellarSDK.scValToNative(sim.result!.retval);

    if (!result) {
      throw new Domain404Error();
    }

    if (result[0] === 'Domain') {
      return {
        type: RecordType.Domain,
        value: {
          node: result[1].node.toString('hex'),
          owner: result[1].owner.toString('hex'),
          address: result[1].address,
          exp_date: result[1].exp_date.toString(),
          snapshot: result[1].snapshot.toString(),
          collateral: result[1].collateral.toString(),
        } satisfies Domain,
      };
    } else {
      return {
        type: RecordType.SubDomain,
        value: {
          node: result[1].node.toString('hex'),
          parent: result[1].parent.toString('hex'),
          address: result[1].address,
          snapshot: result[1].snapshot.toString(),
        } satisfies SubDomain,
      };
    }
  }

  async getDomainData(params: { node: string; key: string }): Promise<DomainStorageValue> {
    if (!this.global.valuesDatabaseContractId) {
      throw new Error(`KeyValue Database contract id was not provided`);
    }

    const contract: Contract = new this.global.stellarSDK.Contract(this.global.valuesDatabaseContractId);
    const nodeBytes: xdr.ScVal = this.global.stellarSDK.xdr.ScVal.scvBytes(Buffer.from(params.node, 'hex'));
    const keySymbol: xdr.ScVal = this.global.stellarSDK.xdr.ScVal.scvSymbol(params.key);

    const account: Account = await this.global.rpc.getAccount(this.global.simulationAccount);

    const transaction: Transaction = new this.global.stellarSDK.TransactionBuilder(account, {
      networkPassphrase: this.global.network,
      fee: this.global.defaultFee,
    })
      .setTimeout(this.global.defaultTimeout || 0)
      .addOperation(contract.call('get', nodeBytes, keySymbol))
      .build();

    const sim: SorobanRpc.Api.SimulateTransactionResponse = await this.global.rpc.simulateTransaction(transaction);

    if (this.global.stellarSDK.SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }

    const result = this.global.stellarSDK.scValToNative(sim.result!.retval);

    if (!result) {
      throw new DomainData404Error();
    }

    return result;
  }

  async setDomainData(params: { node: string; key: string; value: DomainStorageValue; source: string }): Promise<{
    tx: Transaction;
    sim: SorobanRpc.Api.SimulateTransactionRestoreResponse | SorobanRpc.Api.SimulateTransactionSuccessResponse;
  }> {
    if (!this.global.valuesDatabaseContractId) {
      throw new Error(`KeyValue Database contract id was not provided`);
    }

    const contract: Contract = new this.global.stellarSDK.Contract(this.global.valuesDatabaseContractId);
    const nodeBytes: xdr.ScVal = this.global.stellarSDK.xdr.ScVal.scvBytes(Buffer.from(params.node, 'hex'));
    const keySymbol: xdr.ScVal = this.global.stellarSDK.xdr.ScVal.scvSymbol(params.key);
    let value: xdr.ScVal;

    switch (params.value[0]) {
      case 'Bytes':
        value = this.global.stellarSDK.xdr.ScVal.scvVec([
          this.global.stellarSDK.xdr.ScVal.scvSymbol('Bytes'),
          this.global.stellarSDK.xdr.ScVal.scvBytes(params.value[1]),
        ]);
        break;

      case 'Number':
        value = this.global.stellarSDK.xdr.ScVal.scvVec([
          this.global.stellarSDK.xdr.ScVal.scvSymbol('Number'),
          this.global.stellarSDK.nativeToScVal(params.value[1], { type: 'i128' }),
        ]);
        break;

      case 'String':
        value = this.global.stellarSDK.xdr.ScVal.scvVec([
          this.global.stellarSDK.xdr.ScVal.scvSymbol('String'),
          this.global.stellarSDK.xdr.ScVal.scvString(params.value[1]),
        ]);
        break;

      default:
        throw new DomainDataUnsupportedValueType();
    }

    const account: Account = await this.global.rpc.getAccount(params.source);

    const transaction: Transaction = new this.global.stellarSDK.TransactionBuilder(account, {
      networkPassphrase: this.global.network,
      fee: this.global.defaultFee,
    })
      .setTimeout(this.global.defaultTimeout || 0)
      .addOperation(contract.call('set', nodeBytes, keySymbol, value))
      .build();

    const sim: SorobanRpc.Api.SimulateTransactionResponse = await this.global.rpc.simulateTransaction(transaction);

    if (this.global.stellarSDK.SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }

    return {
      tx: this.global.stellarSDK.SorobanRpc.assembleTransaction(transaction, sim).build(),
      sim,
    };
  }

  async removeDomainData(params: { node: string; key: string; source: string }): Promise<{
    tx: Transaction;
    sim: SorobanRpc.Api.SimulateTransactionRestoreResponse | SorobanRpc.Api.SimulateTransactionSuccessResponse;
  }> {
    if (!this.global.valuesDatabaseContractId) {
      throw new Error(`KeyValue Database contract id was not provided`);
    }

    const contract: Contract = new this.global.stellarSDK.Contract(this.global.valuesDatabaseContractId);
    const nodeBytes: xdr.ScVal = this.global.stellarSDK.xdr.ScVal.scvBytes(Buffer.from(params.node, 'hex'));
    const keySymbol: xdr.ScVal = this.global.stellarSDK.xdr.ScVal.scvSymbol(params.key);

    const account: Account = await this.global.rpc.getAccount(params.source);

    const transaction: Transaction = new this.global.stellarSDK.TransactionBuilder(account, {
      networkPassphrase: this.global.network,
      fee: this.global.defaultFee,
    })
      .setTimeout(this.global.defaultTimeout || 0)
      .addOperation(contract.call('remove', nodeBytes, keySymbol))
      .build();

    const sim: SorobanRpc.Api.SimulateTransactionResponse = await this.global.rpc.simulateTransaction(transaction);

    if (this.global.stellarSDK.SorobanRpc.Api.isSimulationError(sim)) {
      throw new Error(sim.error);
    }

    return {
      tx: this.global.stellarSDK.SorobanRpc.assembleTransaction(transaction, sim).build(),
      sim,
    };
  }
}
