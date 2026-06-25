package auth

import (
	"fmt"
	"strings"
)

// Auth controller: login + token issuance.
type Controller struct {
	Base
	AuthApi
	service *Service
}

func (c *Controller) Login(user string) string {
	c.Validate(user)
	return c.service.Greet(user)
}

func (c *Controller) Issue(req TokenReq) Token {
	t := Token{Req: req}
	Log("issued")
	return t
}

func (c *Controller) Validate(user string) {
	if user == "" {
		panic("empty user")
	}
}

func Log(msg string) {
	fmt.Println(msg)
}

type Token struct {
	Req TokenReq `json:"req"`
}

type TokenReq struct {
	Value string
}

type Role int

const (
	Admin Role = iota
	User
)

type Service struct {
	Base
}

func (s *Service) Greet(user string) string {
	return "hi " + strings.TrimSpace(user)
}

type Greeter interface {
	Greet(user string) string
}

type AuthApi interface {
	Login(user string) string
	Issue(req TokenReq) Token
}

type BaseController struct{}

func (b BaseController) TextBlock() string {
	return `hello
multiline`
}

type Stack[T any] struct {
	items []T
}

func (s Stack[T]) Push(v T) {
	s.items = append(s.items, v)
}