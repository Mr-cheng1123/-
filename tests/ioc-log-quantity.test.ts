import test from 'node:test';
import assert from 'node:assert/strict';
import {formatIocReceiptLogMessage} from '../src/shared/ioc-log-quantity.js';

test('retained native IOC receipt messages display arithmetic tails without rewriting the raw entry',()=>{
  const entry={id:'original',message:'SKDD gate 对手价1 IOC 减仓 卖出 0.7000000000000001 / 0.7',context:'原始回执保留'},before=structuredClone(entry);
  assert.equal(formatIocReceiptLogMessage(entry.message),'SKDD gate 对手价1 IOC 减仓 卖出 0.7 / 0.7');
  assert.deepEqual(entry,before);
});

test('zero-fill and no-send receipt labels and the original diagnostic suffix remain distinct',()=>{
  for(const [prefix,suffix] of [['提交前核验未通过；本次未发送创建请求；','；原因：账户实际手续费失效'],
    ['原生订单已终态，零成交（cancelled）；','，等待下一次核验'],
    ['零成交回执未取得原生订单 ID；','，发送状态须按原记录核对']]){
    const message='DOS bitget 对手价1 IOC '+prefix+'卖出 0 / 0.30000000000000004'+suffix;
    assert.equal(formatIocReceiptLogMessage(message),'DOS bitget 对手价1 IOC '+prefix+'卖出 0 / 0.3'+suffix);
  }
  const unknown='DOS bitget 对手价1 IOC 原订单状态未知；保留原 ID 查单，禁止重发';
  assert.equal(formatIocReceiptLogMessage(unknown),unknown);
});

test('real partials, excess fills, tiny fills and high precision counts are not hidden',()=>{
  for(const quantities of ['0.69999999999 / 0.7','0.7000001 / 0.7','1e-21 / 1e-18',
    '1.234567890123456 / 1.234567890123456','1000000000000001 / 1000000000000001',
    '9007199254740991 / 9007199254740990','123456789123456.02 / 123456789123456',
    '12345678912345.703 / 12345678912345.7',
    '9007199254740993 / 9007199254740993']){
    const message='DOS bitget 对手价1 IOC 减仓 卖出 '+quantities;
    assert.equal(formatIocReceiptLogMessage(message),message);
  }
});

test('only exact receipt templates are eligible; unrelated logs, foreign text and noncanonical tokens remain raw',()=>{
  for(const message of ['资金费：0.7000000000000001 / 0.7','DOS bitget 账户数量 0.7000000000000001 / 0.7',
    'DOS bitget 对手价1 IOC 非标准消息 卖出 0.7000000000000001 / 0.7',
    'DOS bitget 对手价1 IOC 减仓 卖出 00.7000000000000001 / 0.70',
    'DOS bitget 对手价1 IOC 减仓 卖出 0.7000000000000001 / 0.70',
    'DOS bitget 对手价1 IOC 减仓 卖出 0.7000000000000001 / 0.7；未知后缀',
    'DOS bitget 对手价1 IOC 提交前核验未通过；本次未发送创建请求；卖出 0 / 0.30000000000000004；原因：未验证原因',
    'DOS other 对手价1 IOC 减仓 卖出 0.7000000000000001 / 0.7'])
    assert.equal(formatIocReceiptLogMessage(message),message);
});
