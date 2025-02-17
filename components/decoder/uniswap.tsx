import { DecodeFormatOpts, Decoder, DecoderInput, DecoderState, hasSelector, hasTopic } from './types';
import { DataRenderer } from '../DataRenderer';
import { BigNumber, BytesLike, ethers } from 'ethers';
import * as React from 'react';
import { EventFragment, Result } from '@ethersproject/abi';
import { FunctionFragment } from '@ethersproject/abi/lib';
import { SwapAction } from './actions';
import { TraceEntry, TraceEntryCall } from '../api';

const uniswapsByRouter: Record<string, any> = {
    '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D': {
        factory: '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f',
        initcodeHash: '0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f',
    },
    '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F': {
        factory: '0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac',
        initcodeHash: '0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303',
    },
};

export class UniswapV2RouterSwapDecoder extends Decoder<SwapAction> {
    functions = {
        'swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] memory path,address to,uint256 deadline) returns (uint[] memory amounts)':
            {
                exactIn: true,
                input: 'tokens',
                output: 'tokens',
                fee: false,
            },
        'swapTokensForExactTokens(uint256 amountOut,uint256 amountInMax,address[] memory path,address to,uint256 deadline) returns (uint[] memory amounts)':
            {
                exactIn: false,
                input: 'tokens',
                output: 'tokens',
                fee: false,
            },
        'swapExactETHForTokens(uint256 amountOutMin,address[] memory path,address to,uint256 deadline) returns (uint[] memory amounts)':
            {
                exactIn: true,
                input: 'eth',
                output: 'tokens',
                fee: false,
            },
        'swapTokensForExactETH(uint256 amountOut,uint256 amountInMax,address[] memory path,address to,uint256 deadline) returns (uint[] memory amounts)':
            {
                exactIn: false,
                input: 'tokens',
                output: 'eth',
                fee: false,
            },
        'swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] memory path,address to,uint256 deadline) returns (uint[] memory amounts)':
            {
                exactIn: true,
                input: 'tokens',
                output: 'eth',
                fee: false,
            },
        'swapETHForExactTokens(uint256 amountOut,address[] memory path,address to,uint256 deadline) returns (uint[] memory amounts)':
            {
                exactIn: false,
                input: 'eth',
                output: 'tokens',
                fee: false,
            },
        'swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] memory path,address to,uint256 deadline)':
            {
                exactIn: true,
                input: 'tokens',
                output: 'tokens',
                fee: true,
            },
        'swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin,address[] memory path,address to,uint256 deadline)':
            {
                exactIn: true,
                input: 'eth',
                output: 'tokens',
                fee: true,
            },
        'swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] memory path,address to,uint256 deadline)':
            {
                exactIn: true,
                input: 'tokens',
                output: 'eth',
                fee: true,
            },
    };

    constructor() {
        super('uniswap-v2-router-swap');
    }

    decodeCall(state: DecoderState, node: DecoderInput): SwapAction | null {
        if (state.isConsumed(node)) return null;
        if (node.type !== 'call') return null;

        const routerInfo = uniswapsByRouter[node.to];
        if (!routerInfo) return null;

        const functionInfo = Object.entries(this.functions).find(([name, func]) => {
            return hasSelector(node.calldata, name);
        });

        if (!functionInfo) return null;

        const [inputs, outputs] = this.decodeFunctionWithFragment(node, FunctionFragment.from(functionInfo[0]));

        const swapMetadata = functionInfo[1];

        // consume events and calls if we have them
        state.consume(node);
        if (swapMetadata.input === 'tokens') {
            this.consumeTokenInputSwap(state, node);
        } else {
            this.consumeETHInputSwap(state, node);
        }
        this.consumeSwaps(state, node);
        if (swapMetadata.output === 'eth') {
            this.consumeETHOutputSwap(state, node);
        }

        const path = inputs['path'];

        const swapResult: SwapAction = {
            type: this.name,
            operator: node.from,
            recipient: inputs['to'],
            tokenIn: path[0],
            tokenOut: path[path.length - 1],
        };

        // flag that we want token metadata to render the result
        state.requestTokenMetadata(swapResult.tokenIn);
        state.requestTokenMetadata(swapResult.tokenOut);

        // pull info from from calldata
        if (swapMetadata.exactIn) {
            swapResult.amountIn = swapMetadata.input === 'eth' ? node.value : inputs['amountIn'];
            swapResult.amountOutMin = inputs['amountOutMin'];
        } else {
            swapResult.amountOut = inputs['amountOut'];
            swapResult.amountInMax = inputs['amountInMax'];
        }

        // pull info from events
        if (node.logs) {
            const swapEventSelector =
                'Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)';

            const abi = new ethers.utils.Interface([EventFragment.from(swapEventSelector)]);

            const swapEvents = node.logs.filter((log) => hasTopic(log, swapEventSelector));
            const [firstToken0, firstToken1] = this.getTokens(path[0], path[1]);
            const firstPairAddress = this.computePairAddress(
                routerInfo.factory,
                routerInfo.initcodeHash,
                firstToken0,
                firstToken1,
            );

            const [lastToken0, lastToken1] = this.getTokens(path[path.length - 2], path[path.length - 1]);
            const lastPairAddress = this.computePairAddress(
                routerInfo.factory,
                routerInfo.initcodeHash,
                lastToken0,
                lastToken1,
            );

            const firstSwapEvent = swapEvents.find((event) => event.address === firstPairAddress);
            const lastSwapEvent = swapEvents.reverse().find((event) => event.address === lastPairAddress);

            if (firstSwapEvent) {
                const parsedEvent = abi.parseLog(firstSwapEvent);

                swapResult.amountIn =
                    firstToken0 === path[0] ? parsedEvent.args['amount0In'] : parsedEvent.args['amount1In'];
            }

            if (lastSwapEvent) {
                const parsedEvent = abi.parseLog(lastSwapEvent);

                swapResult.amountOut =
                    lastToken0 === path[path.length - 1]
                        ? parsedEvent.args['amount0Out']
                        : parsedEvent.args['amount1Out'];
            }
        }

        // pull info from returndata
        if (outputs) {
            if (!swapMetadata.fee) {
                // if the swap is fee-less, we just check get the last amount
                const amounts = outputs['amounts'];

                swapResult.amountOut = amounts[amounts.length - 1];
            } else {
                // otherwise, we need to check the call tree to pull out balance information
                if (node.children) {
                    switch (swapMetadata.output) {
                        case 'tokens':
                            const balanceOfCalls = node.children
                                .filter((v) => v.type === 'staticcall')
                                .filter((v) => hasSelector(v.calldata, 'balanceOf(address)'));

                            // pull out the balanceOf calls
                            const initialBalance = BigNumber.from(balanceOfCalls[0].returndata);
                            const finalBalance = BigNumber.from(balanceOfCalls[balanceOfCalls.length - 1].returndata);
                            swapResult.amountOut = finalBalance.sub(initialBalance);
                            break;
                        case 'eth':
                            const calls = node.children.filter((v) => v.type === 'call');

                            swapResult.amountOut = calls[calls.length - 1].value;
                            break;
                    }
                }
            }
        }

        return swapResult;
    }

    format(result: SwapAction, opts: DecodeFormatOpts): JSX.Element {
        const keys = [];
        const values = [];

        if (result.amountIn !== undefined) {
            keys.push('tokenIn');
            values.push(this.formatTokenAmount(opts, result.tokenIn, result.amountIn));
        } else if (result.amountInMax !== undefined) {
            keys.push('tokenInMax');
            values.push(this.formatTokenAmount(opts, result.tokenIn, result.amountInMax));
        }

        if (result.amountOut !== undefined) {
            keys.push('amountOut');
            values.push(this.formatTokenAmount(opts, result.tokenOut, result.amountOut));
        } else if (result.amountOutMin !== undefined) {
            keys.push('amountOutMin');
            values.push(this.formatTokenAmount(opts, result.tokenOut, result.amountOutMin));
        }

        keys.push('recipient');
        values.push(<DataRenderer chain={opts.chain} preferredType={'address'} data={result.recipient} />);

        keys.push('actor');
        values.push(<DataRenderer chain={opts.chain} preferredType={'address'} data={result.operator} />);

        return this.renderResult('swap', '#645e9d', keys, values);
    }

    getTokens(tokenA: string, tokenB: string): [string, string] {
        return tokenA < tokenB ? [tokenA, tokenB] : [tokenB, tokenA];
    }

    computePairAddress(factory: string, initcodeHash: BytesLike, tokenA: string, tokenB: string) {
        const [token0, token1] = this.getTokens(tokenA, tokenB);

        const salt = ethers.utils.solidityKeccak256(['address', 'address'], [token0, token1]);

        return ethers.utils.getCreate2Address(factory, salt, initcodeHash);
    }

    consumeSwaps(state: DecoderState, node: DecoderInput) {
        node.children
            ?.filter((call) => call.type === 'call')
            .filter((call) => hasSelector(call.calldata, 'swap(uint256,uint256,address,bytes)'))
            .forEach((call) => {
                state.consume(call);

                call.children
                    ?.filter((v) => v.type === 'call' && hasSelector(v.calldata, 'transfer(address,uint256)'))
                    .forEach((v) => state.consumeTransfer(v));
            });
    }

    consumeTokenInputSwap(state: DecoderState, node: DecoderInput) {
        if (node.children) {
            const calls = node.children.filter((v) => v.type === 'call');

            state.consumeTransferFrom(calls[0]);
        }
    }

    consumeETHInputSwap(state: DecoderState, node: DecoderInput) {
        if (node.children) {
            const calls = node.children.filter((v) => v.type === 'call');

            // weth deposit
            state.consumeAll(calls[0]);

            // weth transfer
            state.consumeAll(calls[1]);

            // weth refund
            if (!calls[calls.length - 1].value.isZero()) {
                state.consumeAll(calls[calls.length - 1]);
            }
        }
    }

    consumeETHOutputSwap(state: DecoderState, node: DecoderInput) {
        if (node.children) {
            const calls = node.children.filter((v) => v.type === 'call');

            // weth withdraw
            state.consumeAll(calls[calls.length - 2]);

            // eth transfer
            state.consumeAll(calls[calls.length - 1]);
        }
    }
}

export type UniswapV2RouterAddLiquidityResult = {
    type: string;
    actor: string;
    recipient: string;
    pool: string;
    tokenA: string;
    tokenB: string;

    amountADesired: BigNumber;
    amountBDesired: BigNumber;
    amountAMin: BigNumber;
    amountBMin: BigNumber;

    amountA?: BigNumber;
    amountB?: BigNumber;
    liquidity?: BigNumber;
};

export class UniswapV2RouterAddLiquidityDecoder extends Decoder<UniswapV2RouterAddLiquidityResult> {
    functions = {
        'addLiquidity(address tokenA,address tokenB,uint256 amountADesired,uint256 amountBDesired,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint amountA, uint amountB, uint liquidity)':
            {
                eth: false,
            },
        'addLiquidityETH(address token,uint256 amountTokenDesired,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256) returns (uint amountToken, uint amountETH, uint liquidity)':
            {
                eth: true,
            },
    };

    constructor() {
        super('uniswap-v2-router-add-liquidity');
    }

    decodeCall(state: DecoderState, node: DecoderInput): UniswapV2RouterAddLiquidityResult | null {
        if (state.isConsumed(node)) return null;
        if (node.type !== 'call') return null;

        const functionInfo = Object.entries(this.functions).find(([name, func]) => {
            return hasSelector(node.calldata, name);
        });

        if (!functionInfo) return null;

        const [inputs, outputs] = this.decodeFunctionWithFragment(node, FunctionFragment.from(functionInfo[0]));

        const functionMetadata = functionInfo[1];

        const result = {
            type: this.name,
            actor: node.from,
            recipient: inputs['to'],
            tokenA: functionMetadata.eth ? inputs['token'] : inputs['tokenA'],
            tokenB: functionMetadata.eth ? '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' : inputs['tokenB'],
            amountAMin: functionMetadata.eth ? inputs['amountTokenMin'] : inputs['amountAMin'],
            amountBMin: functionMetadata.eth ? inputs['amountETHMin'] : inputs['amountBMin'],
            amountADesired: functionMetadata.eth ? inputs['amountTokenMin'] : inputs['amountAMin'],
            amountBDesired: functionMetadata.eth ? undefined : inputs['amountBMin'],
        };

        state.requestTokenMetadata(result.tokenA);
        state.requestTokenMetadata(result.tokenB);
        state.requestTokenMetadata(result.pool);

        return result;
    }

    format(result: UniswapV2RouterAddLiquidityResult, opts: DecodeFormatOpts): JSX.Element {
        return this.renderResult(
            'add liquidity',
            '#6c969d',
            ['tokenA', 'tokenB', 'liquidity', 'recipient', 'actor'],
            [
                this.formatTokenAmount(opts, result.tokenA, result.amountA),
                this.formatTokenAmount(opts, result.tokenB, result.amountB),
                this.formatTokenAmount(opts, result.pool, result.liquidity),
                <DataRenderer chain={opts.chain} preferredType={'address'} data={result.recipient} />,
                <DataRenderer chain={opts.chain} preferredType={'address'} data={result.actor} />,
            ],
        );
    }

    // handles the _addLiquidity function
    handleAddLiquidity(node: TraceEntryCall, subcalls: TraceEntryCall[], state: DecodeState): boolean {
        return subcalls[0].input.substring(0, 10) === ethers.utils.id('createPair(address,address)').substring(0, 10);
    }

    decodeAddLiquidity(
        node: TraceEntryCall,
        state: DecodeState,
        inputs: Result,
        outputs: Result,
        subcalls: TraceEntryCall[],
    ) {
        let idx = this.handleAddLiquidity(node, subcalls, state) ? 1 : 0;

        // handle the transfer from tokenA -> pair
        this.handleTransferFrom(state, subcalls[idx]);

        // handle the transfer from tokenB -> pair
        this.handleTransfer(state, subcalls[idx + 1]);

        // handle the mint call
        this.handleRecursively(state, subcalls[idx + 2]);

        return [
            subcalls[idx + 2].to,
            inputs['tokenA'],
            inputs['tokenB'],
            outputs['amountA'],
            outputs['amountB'],
            outputs['liquidity'],
            inputs['to'],
        ];
    }

    decodeAddLiquidityETH(
        node: TraceEntryCall,
        state: DecodeState,
        inputs: Result,
        outputs: Result,
        subcalls: TraceEntryCall[],
    ) {
        let idx = this.handleAddLiquidity(node, subcalls, state) ? 1 : 0;

        // handle the transfer from tokenA -> pair
        this.handleTransferFrom(state, subcalls[idx]);

        // handle the weth deposit
        this.handleRecursively(state, subcalls[idx + 1]);

        // handle the weth transfer
        this.handleRecursively(state, subcalls[idx + 2]);

        // handle the mint call
        this.handleRecursively(state, subcalls[idx + 3]);

        // handle the optional eth refund
        if (idx + 4 < subcalls.length) {
            this.handleRecursively(state, subcalls[idx + 4]);
        }

        return [
            subcalls[idx + 3].to,
            inputs['token'],
            '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            outputs['amountToken'],
            outputs['amountETH'],
            outputs['liquidity'],
            inputs['to'],
        ];
    }
}

export type UniswapV2RouterRemoveLiquidityResult = {
    type: string;
    actor: string;
    recipient: string;
    pool: string;
    tokenA: string;
    tokenB: string;
    amountA: BigNumber;
    amountB: BigNumber;
    liquidity: BigNumber;
};

export class UniswapV2RouterRemoveLiquidityDecoder extends Decoder<UniswapV2RouterRemoveLiquidityResult> {
    addLiquidityFunctions = {
        'removeLiquidity(address tokenA,address tokenB,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline) returns (uint amountA, uint amountB)':
            this.decodeRemoveLiquidity.bind(this),
        'removeLiquidityETH(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) returns (uint amountToken, uint amountETH)':
            this.decodeRemoveLiquidityETH.bind(this),
        'removeLiquidityWithPermit(address tokenA,address tokenB,uint256 liquidity,uint256 amountAMin,uint256 amountBMin,address to,uint256 deadline,bool approveMax,uint8 v,bytes32 r,bytes32 s) returns (uint amountA, uint amountB)':
            this.decodeRemoveLiquidityWithPermit.bind(this),
        'removeLiquidityETHWithPermit(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline,bool approveMax,uint8 v,bytes32 r,bytes32 s) returns (uint amountToken, uint amountETH)':
            this.decodeRemoveLiquidityETHWithPermit.bind(this),
        'removeLiquidityETHSupportingFeeOnTransferTokens(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline) returns (uint amountETH)':
            this.decodeRemoveLiquidityETHSupportingFeeOnTransferTokens.bind(this),
        'removeLiquidityETHWithPermitSupportingFeeOnTransferTokens(address token,uint256 liquidity,uint256 amountTokenMin,uint256 amountETHMin,address to,uint256 deadline,bool approveMax,uint8 v,bytes32 r,bytes32 s) returns (uint amountETH)':
            this.decodeRemoveLiquidityETHWithPermitSupportingFeeOnTransferTokens.bind(this),
    };

    constructor() {
        super('uniswap-v2-router-remove-liquidity');
    }

    decode(node: TraceEntry, state: DecodeState): UniswapV2RouterRemoveLiquidityResult | null {
        if (state.handled[node.path]) return null;

        if (node.type !== 'call') return null;

        let selector = node.input.substring(0, 10);
        let decoder = Object.entries(this.addLiquidityFunctions).find(([name, func]) => {
            return ethers.utils.id(FunctionFragment.from(name).format()).substring(0, 10) === selector;
        });

        if (!decoder) return null;

        state.handled[node.path] = true;

        let [inputs, outputs] = this.decodeFunctionWithFragment(node, FunctionFragment.from(decoder[0]));

        let subcalls: TraceEntryCall[] = node.children.filter(
            (v) => v.type === 'call' && v.variant === 'call',
        ) as TraceEntryCall[];

        let [pool, tokenA, tokenB, amountA, amountB, liquidity, to] = decoder[1](
            node,
            state,
            inputs,
            outputs,
            subcalls,
        );

        this.requestTokenMetadata(state, tokenA);
        this.requestTokenMetadata(state, tokenB);
        this.requestTokenMetadata(state, pool);

        return {
            type: this.name,
            actor: node.from,
            recipient: to,
            pool: pool,
            tokenA: tokenA,
            tokenB: tokenB,
            amountA: amountA,
            amountB: amountB,
            liquidity: liquidity,
        };
    }

    format(result: UniswapV2RouterRemoveLiquidityResult, opts: DecodeFormatOpts): JSX.Element {
        return this.renderResult(
            'remove liquidity',
            '#392b58',
            ['tokenA', 'tokenB', 'liquidity', 'recipient', 'actor'],
            [
                this.formatTokenAmount(opts, result.tokenA, result.amountA),
                this.formatTokenAmount(opts, result.tokenB, result.amountB),
                this.formatTokenAmount(opts, result.pool, result.liquidity),
                <DataRenderer chain={opts.chain} preferredType={'address'} data={result.recipient} />,
                <DataRenderer chain={opts.chain} preferredType={'address'} data={result.actor} />,
            ],
        );
    }

    // handles the removeLiquidity function
    handleRemoveLiquidity(
        node: TraceEntryCall,
        subcalls: TraceEntryCall[],
        state: DecodeState,
        offset: number,
    ): number {
        // handle the transfer from tokenA -> pair
        this.handleTransferFrom(state, subcalls[offset]);

        // handle the burn call
        this.handleRecursively(state, subcalls[offset + 1]);

        return offset + 2;
    }

    decodeRemoveLiquidity(
        node: TraceEntryCall,
        state: DecodeState,
        inputs: Result,
        outputs: Result,
        subcalls: TraceEntryCall[],
    ) {
        this.handleRemoveLiquidity(node, subcalls, state, 0);

        return [
            subcalls[0].to,
            inputs['tokenA'],
            inputs['tokenB'],
            outputs['amountA'],
            outputs['amountB'],
            inputs['liquidity'],
            inputs['to'],
        ];
    }

    decodeRemoveLiquidityETH(
        node: TraceEntryCall,
        state: DecodeState,
        inputs: Result,
        outputs: Result,
        subcalls: TraceEntryCall[],
    ) {
        this.handleRemoveLiquidity(node, subcalls, state, 0);

        // handle the transfer
        this.handleTransfer(state, subcalls[2]);

        // handle the weth withdraw
        this.handleRecursively(state, subcalls[3]);

        // handle the eth return
        state.handled[subcalls[4].path] = true;

        return [
            subcalls[0].to,
            inputs['token'],
            '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            outputs['amountToken'],
            outputs['amountETH'],
            inputs['liquidity'],
            inputs['to'],
        ];
    }

    decodeRemoveLiquidityWithPermit(
        node: TraceEntryCall,
        state: DecodeState,
        inputs: Result,
        outputs: Result,
        subcalls: TraceEntryCall[],
    ) {
        this.handleRemoveLiquidity(node, subcalls, state, 1);

        return [
            subcalls[0].to,
            inputs['tokenA'],
            inputs['tokenB'],
            outputs['amountA'],
            outputs['amountB'],
            inputs['liquidity'],
            inputs['to'],
        ];
    }

    decodeRemoveLiquidityETHWithPermit(
        node: TraceEntryCall,
        state: DecodeState,
        inputs: Result,
        outputs: Result,
        subcalls: TraceEntryCall[],
    ) {
        let offset = this.handleRemoveLiquidity(node, subcalls, state, 1);

        // handle the transfer
        this.handleTransfer(state, subcalls[offset]);

        // handle the weth withdraw
        this.handleRecursively(state, subcalls[offset + 1]);

        // handle the eth return
        state.handled[subcalls[offset + 2].path] = true;

        return [
            subcalls[0].to,
            inputs['token'],
            '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            outputs['amountToken'],
            outputs['amountETH'],
            inputs['liquidity'],
            inputs['to'],
        ];
    }

    decodeRemoveLiquidityETHSupportingFeeOnTransferTokens(
        node: TraceEntryCall,
        state: DecodeState,
        inputs: Result,
        outputs: Result,
        subcalls: TraceEntryCall[],
    ) {
        let offset = this.handleRemoveLiquidity(node, subcalls, state, 0);

        // handle the transfer
        this.handleTransfer(state, subcalls[offset]);

        // handle the weth withdraw
        this.handleRecursively(state, subcalls[offset + 1]);

        // handle the eth return
        state.handled[subcalls[offset + 2].path] = true;

        let staticcalls = node.children.filter(
            (v): v is TraceEntryCall => v.type === 'call' && v.variant === 'staticcall',
        );
        let output = BigNumber.from(staticcalls[staticcalls.length - 1].output);

        return [
            subcalls[0].to,
            inputs['token'],
            '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            output,
            outputs['amountETH'],
            inputs['liquidity'],
            inputs['to'],
        ];
    }

    decodeRemoveLiquidityETHWithPermitSupportingFeeOnTransferTokens(
        node: TraceEntryCall,
        state: DecodeState,
        inputs: Result,
        outputs: Result,
        subcalls: TraceEntryCall[],
    ) {
        let offset = this.handleRemoveLiquidity(node, subcalls, state, 1);

        // handle the transfer
        this.handleTransfer(state, subcalls[offset]);

        // handle the weth withdraw
        this.handleRecursively(state, subcalls[offset + 1]);

        // handle the eth return
        state.handled[subcalls[offset + 2].path] = true;

        let staticcalls = node.children.filter(
            (v): v is TraceEntryCall => v.type === 'call' && v.variant === 'staticcall',
        );
        let output = BigNumber.from(staticcalls[staticcalls.length - 1].output);

        return [
            subcalls[0].to,
            inputs['token'],
            '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
            output,
            outputs['amountETH'],
            inputs['liquidity'],
            inputs['to'],
        ];
    }
}
