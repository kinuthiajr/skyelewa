// Data structure that the Listener will create from the raw AT protocol and pass it to elewaservice


export interface MentionEvent{
    // The DID of the author who mentioned
    authorDid: string;
    // The URI of the post where the mention occurred
    postUri: string;
    // The Content Identifier (CID) of the post
    postCid: string;
    // The clean query string used for searching
    cleanQuery: string;
}