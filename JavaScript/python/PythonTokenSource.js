/*
 [The "BSD licence"]
 Copyright (c) 2004 Terence Parr and Loring Craymer
 All rights reserved.

 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions
 are met:
 1. Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
 2. Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.
 3. The name of the author may not be used to endorse or promote products
    derived from this software without specific prior written permission.

 THIS SOFTWARE IS PROVIDED BY THE AUTHOR ``AS IS'' AND ANY EXPRESS OR
 IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES
 OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED.
 IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT, INDIRECT,
 INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
 NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF
 THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/


/** Python does not explicitly provide begin and end nesting signals.
 Rather, the indentation level indicates when you begin and end.
 This is an interesting lexical problem because multiple DEDENT
 tokens should be sent to the parser sometimes without a corresponding
 input symbol!  Consider the following example:

 a=1
 if a>1:
     print a
 b=3

 Here the "b" token on the left edge signals that a DEDENT is needed
 after the "print a \n" and before the "b".  The sequence should be

 ... 1 COLON NEWLINE INDENT PRINT a NEWLINE DEDENT b ASSIGN 3 ...

 For more examples, see the big comment at the bottom of this file.

 This TokenStream normally just passes tokens through to the parser.
 Upon NEWLINE token from the lexer, however, an INDENT or DEDENT token
 may need to be sent to the parser.  The NEWLINE is the trigger for
 this class to do it's job.  NEWLINE is saved and then the first token
 of the next line is examined.  If non-leading-whitespace token,
 then check against stack for indent vs dedent.  If LEADING_WS, then
 the column of the next non-whitespace token will dictate indent vs
 dedent.  The column of the next real token is number of spaces
 in the LEADING_WS token + 1 (to move past the whitespace).  The
 lexer grammar must set the text of the LEADING_WS token to be
 the proper number of spaces (and do tab conversion etc...).

 A stack of column numbers is tracked and used to detect changes
 in indent level from one token to the next.

 A queue of tokens is built up to hold multiple DEDENT tokens that
 are generated.  Before asking the lexer for another token via
 nextToken(), the queue is flushed first one token at a time.

 Terence Parr and Loring Craymer
 February 2004
 */
PythonTokenSource = function(stream) {
    this.stream = stream;
	/** The stack of indent levels (column numbers) */
	this.indentStack = new Array(PythonTokenSource.MAX_INDENTS);
	/** stack pointer */
	this.sp=-1; // grow upwards

	/** The queue of tokens */
	this.tokens = [];
	this.lastTokenAddedIndex = -1;
	this.push(PythonTokenSource.FIRST_CHAR_POSITION);
};

PythonTokenSource.MAX_INDENTS = 100;
PythonTokenSource.FIRST_CHAR_POSITION = 0;


PythonTokenSource.prototype = {
	getSourceName: function() {
		return this.stream.getSourceName();
	},

	/** From http://www.python.org/doc/2.2.3/ref/indentation.html

	 "Before the first line of the file is read, a single zero is
	 pushed on the stack; this will never be popped off again. The
	 numbers pushed on the stack will always be strictly increasing
	 from bottom to top. At the beginning of each logical line, the
	 line's indentation level is compared to the top of the
	 stack. If it is equal, nothing happens. If it is larger, it is
	 pushed on the stack, and one INDENT token is generated. If it
	 is smaller, it must be one of the numbers occurring on the
	 stack; all numbers on the stack that are larger are popped
	 off, and for each number popped off a DEDENT token is
	 generated. At the end of the file, a DEDENT token is generated
	 for each number remaining on the stack that is larger than
	 zero."

	 I use char position in line 0..n-1 instead.

	 The DEDENTS possibly needed at EOF are gracefully handled by forcing
	 EOF to have char pos 0 even though with UNIX it's hard to get EOF
	 at a non left edge.
	 */
	nextToken: function() {
		// if something in queue, just remove and return it
		if (this.tokens.length>0 ) {
			var t = this.tokens[0];
			this.tokens.splice(0,1);
			return t;
		}

		this.insertImaginaryIndentDedentTokens();

		return this.nextToken();
	},

	insertImaginaryIndentDedentTokens: function()
	{
		var t = this.stream.LT(1);
		this.stream.consume();

		// if not a NEWLINE, doesn't signal indent/dedent work; just enqueue
		if ( t.getType()!=PythonLexer.NEWLINE ) {
			var hiddenTokens = this.stream.getTokens(this.lastTokenAddedIndex+1,t.getTokenIndex()-1);
			if ( hiddenTokens!=null ) {
				this.tokens = this.tokens.concat(hiddenTokens);
			}
			this.lastTokenAddedIndex = t.getTokenIndex();
			this.tokens.push(t);
			return;
		}

		// save NEWLINE in the queue
		var hiddenTokens = this.stream.getTokens(this.lastTokenAddedIndex+1,t.getTokenIndex()-1);
		if ( hiddenTokens!=null ) {
			this.tokens = this.tokens.concat(hiddenTokens);
		}
		this.lastTokenAddedIndex = t.getTokenIndex();
		this.tokens.push(t);

		// grab first token of next line
		t = this.stream.LT(1);
		this.stream.consume();

		hiddenTokens = this.stream.getTokens(this.lastTokenAddedIndex+1,t.getTokenIndex()-1);
		if ( hiddenTokens!=null ) {
			this.tokens = this.tokens.concat(hiddenTokens);
		}
		this.lastTokenAddedIndex = t.getTokenIndex();

		// compute cpos as the char pos of next non-WS token in line
		var cpos = t.getCharPositionInLine(); // column dictates indent/dedent
		if ( t.getType()==org.antlr.runtime.Token.EOF ) {
			cpos = -1; // pretend EOF always happens at left edge
		}
		else if ( t.getType()==PythonLexer.LEADING_WS ) {
			cpos = t.getText().length;
		}

		// compare to last indent level
		var lastIndent = this.peek();
		if ( cpos > lastIndent ) { // they indented; track and gen INDENT
			this.push(cpos);
			var indent = new org.antlr.runtime.CommonToken(PythonParser.INDENT, "");
			indent.setCharPositionInLine(t.getCharPositionInLine());
			indent.setLine(t.getLine());
			this.tokens.push(indent);
		}
		else if ( cpos < lastIndent ) { // they dedented
			// how far back did we dedent?
			var prevIndex = this.findPreviousIndent(cpos);
			// generate DEDENTs for each indent level we backed up over
			for (var d=this.sp-1; d>=prevIndex; d--) {
				var dedent = new org.antlr.runtime.CommonToken(PythonParser.DEDENT, "");
				dedent.setCharPositionInLine(t.getCharPositionInLine());
				dedent.setLine(t.getLine());
				this.tokens.push(dedent);
			}
			this.sp = prevIndex; // pop those off indent level
		}
		if ( t.getType()!=PythonLexer.LEADING_WS ) { // discard WS
			this.tokens.push(t);
		}
	},

	//  T O K E N  S T A C K  M E T H O D S

	push: function(i) {
		if (this.sp>=PythonTokenSource.MAX_INDENTS) {
			throw new Error("stack overflow");
		}
		this.sp++;
		this.indentStack[this.sp] = i;
	},

	pop: function() {
		if (this.sp<0) {
			throw new Error("stack underflow");
		}
		var top = this.indentStack[this.sp];
		this.sp--;
		return top;
	},

	peek: function() {
		return this.indentStack[this.sp];
	},

	/** Return the index on stack of previous indent level == i else -1 */
	findPreviousIndent: function(i) {
		for (var j=this.sp-1; j>=0; j--) {
			if (this.indentStack[j]==i ) {
				return j;
			}
		}
		return PythonTokenSource.FIRST_CHAR_POSITION;
	},

	stackString: function() {
		var buf = [];
		for (var j=this.sp; j>=0; j--) {
			buf.push(this.indentStack[j]);
		}
		return buf.join(" ");
	}

}

/* More example input / output pairs with code simplified to single chars
------- t1 -------
a a
        b b
        c
d
a a \n INDENT b b \n c \n DEDENT d \n EOF
------- t2 -------
a  c
 b
c
a c \n INDENT b \n DEDENT c \n EOF 
------- t3 -------
a
        b
                c
d
a \n INDENT b \n INDENT c \n DEDENT DEDENT d \n EOF 
------- t4 -------
a
    c
                  d
    e
    f
             g
             h
             i
              j
    k
a \n INDENT c \n INDENT d \n DEDENT e \n f \n INDENT g \n h \n i \n INDENT j \n DEDENT DEDENT k \n DEDENT EOF 
------- t5 -------
a
        b
        c
                d
                e
a \n INDENT b \n c \n INDENT d \n e \n DEDENT DEDENT EOF 
*/
