/**
 * Because this library can work in a browser as well as a NodeJS server, we need to declare some
 * global types to make typescript allow us to use them.
 */

// For some reason, our library is still including node types, so we don't need this (and in fact
// can't use it because it conflicts with node types). Leaving it out for now.
//declare type Buffer = any;

declare function btoa(s: string): string;
