import { Mw, RequestParameters } from './Mw';
import WebSocket from 'ws';
import * as pty from 'node-pty';
import * as os from 'os';
import { IPty } from 'node-pty';
import { Message } from '../../common/Message';
import { XtermClientMessage, XtermServiceParameters } from '../../common/XtermMessage';
import { ACTION } from '../Constants';
import { AdbUtils } from '../AdbUtils';

const OS_WINDOWS = os.platform() === 'win32';
const USE_BINARY = !OS_WINDOWS;
const EVENT_TYPE_SHELL = 'shell';

export class RemoteShell extends Mw {
    public static readonly TAG = 'RemoteShell';
    private term?: IPty;
    private initialized = false;

    public static processRequest(ws: WebSocket, params: RequestParameters): RemoteShell | undefined {
        if (params.parsedQuery?.action !== ACTION.SHELL) {
            return;
        }
        return new RemoteShell(ws);
    }

    constructor(ws: WebSocket) {
        super(ws);
    }

    public createTerminal(params: XtermServiceParameters): IPty {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const env = Object.assign({}, process.env) as any;
        env['COLORTERM'] = 'truecolor';
        const { cols = 80, rows = 24 } = params;
        const cwd = env.PWD || '/';
        const file = OS_WINDOWS ? 'adb.exe' : 'adb';
        const term = pty.spawn(file, ['-s', params.udid, 'shell'], {
            name: 'xterm-256color',
            cols,
            rows,
            cwd,
            env,
            encoding: null,
        });
        const send = USE_BINARY ? this.bufferUtf8(5) : this.buffer(5);
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore Documentation is incorrect for `encoding: null`
        term.on('data', send);
        term.on('exit', (code: number) => {
            this.ws.close(1000, `[${[RemoteShell.TAG]}] terminal process exited with code: ${code}`);
        });
        return term;
    }

    protected onSocketMessage(event: WebSocket.MessageEvent): void {
        if (this.initialized) {
            if (!this.term) {
                return;
            }
            return this.term.write(event.data as string);
        }
        let data;
        try {
            data = JSON.parse(event.data.toString());
        } catch (e) {
            console.error(`[${RemoteShell.TAG}]`, e.message);
            return;
        }
        this.handleMessage(data as Message).catch((e: Error) => {
            console.error(`[${RemoteShell.TAG}]`, e.message);
        });
    }

    private handleMessage = async (message: Message): Promise<void> => {
        if (message.type !== EVENT_TYPE_SHELL) {
            return;
        }
        const data: XtermClientMessage = message.data as XtermClientMessage;
        const { type } = data;
        if (type === 'start') {
            await AdbUtils.forward(data.udid, "tcp:8886")
            this.term = this.createTerminal(data);
            this.initialized = true;
        }
        if (type === 'stop') {
            this.release();
        }
    };

    // string message buffering
    private buffer(timeout: number): (data: string) => void {
        let s = '';
        let sender: NodeJS.Timeout | null = null;
        return (data: string) => {
            s += data;
            if (!sender) {
                sender = setTimeout(() => {
                    this.ws.send(s);
                    s = '';
                    sender = null;
                }, timeout);
            }
        };
    }

    private bufferUtf8(timeout: number): (data: Buffer) => void {
        let buffer: Buffer[] = [];
        let sender: NodeJS.Timeout | null = null;
        let length = 0;
        return (data: Buffer) => {
            buffer.push(data);
            length += data.length;
            if (!sender) {
                sender = setTimeout(() => {
                    this.ws.send(Buffer.concat(buffer, length));
                    buffer = [];
                    sender = null;
                    length = 0;
                }, timeout);
            }
        };
    }

    public release(): void {
        super.release();
        if (this.term) {
            this.term.kill();
        }
    }
}
